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
import type { Executor, ExecutionResult, TxClient } from "../../src/executor.ts";
import type { MaskingConfig } from "../../src/engine.ts";

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
