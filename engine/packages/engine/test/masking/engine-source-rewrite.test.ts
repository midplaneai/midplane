// Engine.handle integration with the SOURCE-REWRITE path (T0 wiring).
//
// Proves the handle() branch: when masking is configured with sourceRewrite.enabled
// and the executor supports withTransaction, a masked query is rewritten at the
// source and the REWRITTEN sql is what executes; the covert-channel shape gate
// denies opaque reads (column_masking) without executing. Value-level masking is
// proven by the rewriter unit tests + the live-PG spike; here we assert the wiring.

import { beforeAll, describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import { MemoryAuditWriter, StubCredentialStore, baseCtx } from "../_helpers.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import { postgresSourceRewriter } from "../../src/dialects/postgres/source-rewrite.ts";
import { warmup } from "../../src/dialects/postgres/index.ts";
import type { ColumnMasks } from "../../src/masking/mask-result-set.ts";
import type { CatalogResolver } from "../../src/masking/catalog.ts";
import { SourceRewriteExecError } from "../../src/masking/source-rewrite.ts";
import type { Executor, ExecutionResult, TxClient } from "../../src/executor.ts";
import type { MaskingConfig } from "../../src/engine.ts";
import type { SourceRewriteSignal } from "../../src/masking/source-rewrite.ts";

beforeAll(async () => {
  await warmup();
});

const MASKS: ColumnMasks = new Map([["public.users", new Map([["email", "full-redact"]])]]);
const stubResolver: CatalogResolver = { resolve: async () => new Map(), invalidate: () => {} };

// Executor that runs the rewrite path: withTransaction answers the catalog queries
// for `users` and records the (rewritten) SQL exec() runs.
class RewriteMockExecutor implements Executor {
  executed: string[] = [];
  plainCalls = 0;
  result: ExecutionResult = { rows: [{ email: "x" }], rowCount: 1, fields: [] };

  async execute(): Promise<ExecutionResult> {
    this.plainCalls++;
    return this.result;
  }
  async withTransaction<T>(_ctx: unknown, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const self = this;
    const tx: TxClient = {
      async query(sql, params = []) {
        if (sql.includes("set_config")) return [{ v: params[1] }];
        if (sql.includes("(n.nspname, c.relname) IN"))
          return [{ oid: 100, relname: "users", relkind: "r", schema: "public" }];
        if (sql.includes("FROM pg_inherits")) return [];
        if (sql.includes("c.oid = ANY($1::oid[])") && sql.includes("relname"))
          return [{ oid: 100, relname: "users", schema: "public" }];
        if (sql.includes("pg_attribute"))
          return [
            { oid: 100, attname: "id", typcategory: "N" },
            { oid: 100, attname: "email", typcategory: "S" },
            { oid: 100, attname: "ssn", typcategory: "S" },
          ];
        return []; // pg_proc shadow scan etc.
      },
      async exec(sql) {
        self.executed.push(sql);
        return self.result;
      },
    };
    return fn(tx);
  }
}

function makeEngine(masking: MaskingConfig, executor: Executor) {
  const audit = new MemoryAuditWriter();
  let counter = 0;
  const engine = new Engine({
    policy: {
      rules: [parseError(), multiStatement(), tableAccess(), tenantScope(), dangerousStatement()],
    },
    audit,
    credentials: new StubCredentialStore(),
    executor,
    masking,
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });
  return { engine, audit };
}

describe("Engine.handle + source-rewrite", () => {
  test("a masked query executes the REWRITTEN sql (wrap) on the tx and audits columns_masked", async () => {
    const executor = new RewriteMockExecutor();
    const audit = new MemoryAuditWriter();
    let counter = 0;
    const engine = new Engine({
      policy: {
        rules: [parseError(), multiStatement(), tableAccess(), tenantScope(), dangerousStatement()],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor,
      masking: {
        columnMasks: MASKS,
        salt: "s3cret",
        resolver: stubResolver,
        sourceRewrite: { enabled: true, rewriter: postgresSourceRewriter },
      },
      now: () => 1_700_000_000_000,
      idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
    });

    const d = await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });

    expect(d.allowed).toBe(true);
    // the rewrite path executed the WRAPPED sql, not the original, and never the
    // plain execute() path.
    expect(executor.plainCalls).toBe(0);
    expect(executor.executed).toHaveLength(1);
    expect(executor.executed[0]).toContain("'***'::text AS \"email\"");
    expect(executor.executed[0]).toContain("FROM (SELECT");
    const exec = audit.byType("EXECUTED")[0]!;
    expect((exec.payload as { columns_masked?: string[] }).columns_masked).toEqual(["public.users.email"]);
  });

  test("covert-channel: query_to_xml is denied, never executes, and is NOT audited as EXECUTED (reviewer #3)", async () => {
    const executor = new RewriteMockExecutor();
    const { engine, audit } = makeEngine(
      {
        columnMasks: MASKS,
        salt: "s3cret",
        resolver: stubResolver,
        sourceRewrite: { enabled: true, rewriter: postgresSourceRewriter },
      },
      executor,
    );

    const d = await engine.handle({
      sql: "SELECT query_to_xml('SELECT email FROM users', true, false, '')",
      ctx: baseCtx,
    });

    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("column_masking");
    expect(executor.executed).toHaveLength(0); // never opened/executed
    expect(executor.plainCalls).toBe(0);
    // a denied pre-execution attempt must NOT look executed in the audit log.
    expect(audit.byType("EXECUTED")).toHaveLength(0);
    const failed = audit.byType("FAILED")[0]!;
    expect((failed.payload as { error_class?: string }).error_class).toBe("column_masking");
  });

  test("current_setting (salt-read attempt) is denied and audited as a masking denial, not executed", async () => {
    const executor = new RewriteMockExecutor();
    const { engine, audit } = makeEngine(
      {
        columnMasks: MASKS,
        salt: "s3cret",
        resolver: stubResolver,
        sourceRewrite: { enabled: true, rewriter: postgresSourceRewriter },
      },
      executor,
    );
    const d = await engine.handle({ sql: "SELECT current_setting('midplane.mask_salt')", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect(executor.executed).toHaveLength(0);
    expect(audit.byType("EXECUTED")).toHaveLength(0);
    expect((audit.byType("FAILED")[0]!.payload as { error_class?: string }).error_class).toBe("column_masking");
  });
});

// A2: observability signals, audit enrichment (masking_path / masking_stage), and
// error hygiene (a rewrite exec error never leaks the wrap / salt to the agent).
describe("Engine.handle + source-rewrite: observability & error hygiene (A2)", () => {
  // Executor whose rewritten-query exec() THROWS a PG-shaped error whose message
  // embeds the wrap AND the salt — exactly what must never reach the agent.
  class ExecThrowsExecutor implements Executor {
    plainCalls = 0;
    async execute(): Promise<ExecutionResult> {
      this.plainCalls++;
      return { rows: [], rowCount: 0, fields: [] };
    }
    async withTransaction<T>(_ctx: unknown, fn: (tx: TxClient) => Promise<T>): Promise<T> {
      const tx: TxClient = {
        async query(sql, params = []) {
          if (sql.includes("set_config")) return [{ v: params[1] }];
          if (sql.includes("(n.nspname, c.relname) IN"))
            return [{ oid: 100, relname: "users", relkind: "r", schema: "public" }];
          if (sql.includes("FROM pg_inherits")) return [];
          if (sql.includes("c.oid = ANY($1::oid[])") && sql.includes("relname"))
            return [{ oid: 100, relname: "users", schema: "public" }];
          if (sql.includes("pg_attribute"))
            return [
              { oid: 100, attname: "id", typcategory: "N" },
              { oid: 100, attname: "email", typcategory: "S" },
            ];
          return [];
        },
        async exec(sql) {
          const e = new Error(
            `syntax error at or near "${sql}" while salt=s3cret was set`,
          ) as Error & { code?: string };
          e.code = "42601";
          throw e;
        },
      };
      return fn(tx);
    }
  }

  function makeEngineWithObserver(opts: { enabled: boolean }, executor: Executor) {
    const signals: SourceRewriteSignal[] = [];
    const audit = new MemoryAuditWriter();
    let counter = 0;
    const engine = new Engine({
      policy: {
        rules: [parseError(), multiStatement(), tableAccess(), tenantScope(), dangerousStatement()],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor,
      masking: {
        columnMasks: MASKS,
        salt: "s3cret",
        resolver: stubResolver,
        sourceRewrite: {
          enabled: opts.enabled,
          rewriter: postgresSourceRewriter,
          observer: (s) => signals.push(s),
        },
      },
      now: () => 1_700_000_000_000,
      idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
    });
    return { engine, audit, signals };
  }

  test("a masked rewrite success stamps masking_path=source_rewrite on EXECUTED", async () => {
    const { engine, audit } = makeEngineWithObserver({ enabled: true }, new RewriteMockExecutor());
    await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    expect((audit.byType("EXECUTED")[0]!.payload as { masking_path?: string }).masking_path).toBe("source_rewrite");
  });

  test("the salt-redacted rewritten SQL is emitted via the observer (never the salt)", async () => {
    const { engine, signals } = makeEngineWithObserver({ enabled: true }, new RewriteMockExecutor());
    await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    const rewritten = signals.find((s) => s.kind === "rewritten");
    expect(rewritten).toBeDefined();
    if (rewritten?.kind === "rewritten") {
      expect(rewritten.redactedSql).toContain("'***'::text");
      expect(rewritten.redactedSql).not.toContain("s3cret");
      expect(rewritten.maskedColumns).toEqual(["public.users.email"]);
    }
  });

  test("a covert-channel gate reject stamps masking_stage=gate on the FAILED audit", async () => {
    const { engine, audit } = makeEngineWithObserver({ enabled: true }, new RewriteMockExecutor());
    await engine.handle({ sql: "SELECT query_to_xml('SELECT email FROM users', true, false, '')", ctx: baseCtx });
    const failed = audit.byType("FAILED")[0]!;
    expect((failed.payload as { masking_stage?: string }).masking_stage).toBe("gate");
  });

  test("error hygiene: a rewritten-query PG error is sanitized — no wrap, no salt, SQLSTATE kept", async () => {
    const { engine, audit } = makeEngineWithObserver({ enabled: true }, new ExecThrowsExecutor());
    let thrown: unknown;
    try {
      await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SourceRewriteExecError);
    const err = thrown as SourceRewriteExecError;
    // Agent-facing: generic message, no wrap / mask expr / salt, SQLSTATE preserved.
    expect(err.message).toBe("query execution failed after masking was applied");
    expect(err.message).not.toContain("s3cret");
    expect(err.message).not.toContain("'***'");
    expect(err.code).toBe("42601");
    // The FAILED audit records the sanitized message + real SQLSTATE — not the wrap.
    const failed = audit.byType("FAILED")[0]!;
    const payload = failed.payload as { error_class?: string; error_message?: string };
    expect(payload.error_class).toBe("42601");
    expect(payload.error_message).not.toContain("s3cret");
    expect(payload.error_message).not.toContain("SELECT id");
  });

  test("error hygiene: the operator still gets the (salt-redacted) exec_error detail via the observer", async () => {
    const { engine, signals } = makeEngineWithObserver({ enabled: true }, new ExecThrowsExecutor());
    await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx }).catch(() => {});
    const execErr = signals.find((s) => s.kind === "exec_error");
    expect(execErr).toBeDefined();
    if (execErr?.kind === "exec_error") {
      expect(execErr.sqlstate).toBe("42601");
      // operator sees the redacted rewritten SQL (the wrap), but never the salt.
      expect(execErr.redactedSql).toContain("'***'::text");
      expect(execErr.redactedSql).not.toContain("s3cret");
      expect(execErr.message).toContain("‹redacted-salt›"); // salt scrubbed from the PG message too
    }
  });

  test("flag ON but the executor can't open a transaction ⇒ fallback signal + post-exec masker", async () => {
    // No withTransaction ⇒ runSourceRewrite returns null ⇒ fall back, and surface it.
    const noTxExecutor: Executor = {
      execute: async () => ({ rows: [], rowCount: 0, fields: [] }),
    };
    const { engine, signals, audit } = makeEngineWithObserver({ enabled: true }, noTxExecutor);
    const d = await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    expect(d.allowed).toBe(true);
    expect(signals.find((s) => s.kind === "fallback")).toEqual({ kind: "fallback", reason: "no_transaction" });
    // it took the post-exec path.
    expect((audit.byType("EXECUTED")[0]!.payload as { masking_path?: string }).masking_path).toBe("post_exec");
  });

  test("flag OFF ⇒ post-exec path, masking_path=post_exec, no source-rewrite signals", async () => {
    const { engine, signals, audit } = makeEngineWithObserver({ enabled: false }, new RewriteMockExecutor());
    await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    expect(signals).toHaveLength(0); // steady-state flag-off is silent (not per-query noise)
    expect((audit.byType("EXECUTED")[0]!.payload as { masking_path?: string }).masking_path).toBe("post_exec");
  });
});
