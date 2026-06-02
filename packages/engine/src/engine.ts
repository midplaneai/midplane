// Midplane engine — class-based with dependency injection.
//
// Pipeline (locked, T3): parse → policy → audit(ATTEMPTED) →
// audit(DECIDED) → if ALLOW execute → audit(EXECUTED|FAILED).
//
// Audit failure on ATTEMPTED or DECIDED throws AuditUnavailableError and
// the query is NOT executed. Audit failure after exec is logged but not
// fatal (the ATTEMPTED+DECIDED row already proves intent).
//
// Policy denials are NORMAL Decision returns, not exceptions.
// Infrastructure failures (audit/KMS/parser) are typed exceptions.

import { ulid } from "ulid";
import { createHash } from "node:crypto";
import type { AuditWriter } from "./audit/index.ts";
import type { CredentialStore } from "./crypto/credential-store.ts";
import type { Executor, ExecutionResult } from "./executor.ts";
import type { Rule } from "./policy/rules/index.ts";
import { evaluate } from "./policy/index.ts";
import type { Dialect } from "./dialects/types.ts";
import { postgresDialect } from "./dialects/postgres/index.ts";
import { AuditEvent } from "./audit/types.ts";
import { AuditUnavailableError } from "./errors.ts";

export type EngineContext = {
  tenant_id: string;
  // MCP `clientInfo.name`/`version`, captured at MCP `initialize` and
  // cached on the session. Both null for non-MCP callers (raw HTTP, CLI).
  // Stamped on every audit row emitted from the session.
  agent_name: string | null;
  agent_version: string | null;
  // Cloud-issued ULID identifying the MCP token that opened this session.
  // Sourced from the `X-Midplane-Token-Id` HTTP header at MCP `initialize`
  // and cached on the session — the engine never reads the header itself.
  // Stamped on every audit row so cloud-side indexers can answer "which
  // token ran this query?" without joining back to live session state.
  // Null when the header was absent or malformed at initialize, on
  // non-MCP callers, and on POLICY_RELOADED audit rows.
  mcp_token_id: string | null;
  role?: string;
  // Optional opt-in tenant-scope context. Legacy `mappings` is a flat
  // `table → column` dict (pre-0.5.0). The 0.5.0 shape adds a universal
  // `defaultColumn` (strict mode: every queried table needs the predicate),
  // per-table `overrides`, and an `exempt` list. Production wires this
  // through `tenantScope()`'s source arg, not ctx; the ctx form is for
  // tests that don't construct a holder.
  tenant_scope?: {
    mappings?: Record<string, string>;
    defaultColumn?: string | null;
    overrides?: Record<string, string>;
    exempt?: string[];
  };
};

// Per-call free-text task description. Sourced from a required `intent`
// field on the `query` tool's structured input (validated + capped at the
// tool boundary). Tools that don't accept an intent arg pass null.
export type AgentIntent = string;

export type Decision =
  | { allowed: true; result: ExecutionResult; auditId: string }
  // `reason` is the wire-level rule name (e.g. "table_access") for the
  // agent's structured branching; `message` is the polished, agent-facing
  // sentence the rule produced.
  | { allowed: false; reason: string; message: string; auditId: string };

export interface EngineOptions {
  policy: { rules: Rule[] };
  audit: AuditWriter;
  credentials: CredentialStore;
  executor: Executor;
  // Identifies which DB this Engine is bound to. Stamped on every audit
  // event the engine writes so consumers can group/filter per-DB. Defaults
  // to '__default__' for legacy single-DB callers and tests that don't
  // care to supply one.
  databaseName?: string;
  // Dialect that owns parsing for this engine. Defaults to `postgresDialect`
  // for back-compat with pre-0.6.0 callers (tests, embedders) that don't
  // construct one. The factory in `@midplane/mcp-server` resolves the dialect
  // from per-DB YAML (`dialect: postgres|...`) and passes it explicitly.
  dialect?: Dialect;
  now?: () => number;
  idGen?: () => string;
}

export class Engine {
  private readonly rules: Rule[];
  private readonly audit: AuditWriter;
  private readonly executor: Executor;
  private readonly credentials: CredentialStore;
  private readonly databaseName: string;
  private readonly dialect: Dialect;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(opts: EngineOptions) {
    this.rules = opts.policy.rules;
    this.audit = opts.audit;
    this.executor = opts.executor;
    this.credentials = opts.credentials;
    this.databaseName = opts.databaseName ?? "__default__";
    this.dialect = opts.dialect ?? postgresDialect;
    this.now = opts.now ?? Date.now;
    this.idGen = opts.idGen ?? ulid;
  }

  async handle(input: {
    sql: string;
    ctx: EngineContext;
    intent?: AgentIntent | null;
  }): Promise<Decision> {
    const start = this.now();
    const queryId = this.idGen();
    const intent = input.intent ?? null;

    // ── 1. parse — never throws past here. A WASM crash converts to a
    //    synthetic parse-failure ParseResult so ATTEMPTED still records
    //    the agent's intent before any policy runs.
    let parseResult: Awaited<ReturnType<Dialect["parse"]>>;
    try {
      parseResult = await this.dialect.parse(input.sql);
    } catch (err) {
      parseResult = {
        ok: false,
        error: `parser_crashed: ${(err as Error)?.message ?? String(err)}`,
      };
    }

    // ── 2. audit ATTEMPTED — written BEFORE policy so a misbehaving rule
    //    or future built-in bug cannot disappear the query from audit.
    //    Failure here is fatal (per T3): query never executes without intent recorded.
    const fingerprint = computeFingerprint(input.sql, parseResult);
    const attemptedEvent: AuditEvent = {
      id: this.idGen(),
      query_id: queryId,
      tenant_id: input.ctx.tenant_id,
      database: this.databaseName,
      agent_name: input.ctx.agent_name,
      agent_version: input.ctx.agent_version,
      agent_intent: intent,
      mcp_token_id: input.ctx.mcp_token_id,
      ts: this.now(),
      schema_version: 3,
      event_type: "ATTEMPTED",
      payload: {
        sql_raw: input.sql.length === 0 ? " " : input.sql.slice(0, 1_048_576),
        sql_fingerprint: fingerprint,
      },
    };
    await this.writeOrThrow(attemptedEvent);

    // ── 3. policy — wrapped so any rule throw produces a clean DENY
    //    DECIDED row with reason=internal_error rather than an unhandled
    //    exception. The original error is logged to ops for diagnosis.
    let evalResult: ReturnType<typeof evaluate>;
    try {
      evalResult = evaluate({
        parse: parseResult,
        ctx: input.ctx,
        rules: this.rules,
        dialect: this.dialect,
      });
    } catch (err) {
      console.error("[engine] policy evaluation threw:", err);
      evalResult = {
        verdict: { decision: "DENY", reason: "internal_error" },
        statementType: null,
        tablesTouched: [],
      };
    }

    // ── 4. audit DECIDED — failure here aborts the pipeline.
    const decidedId = this.idGen();
    const denyMessage =
      evalResult.verdict.decision === "DENY"
        ? evalResult.verdict.message ?? defaultMessageForRule(evalResult.verdict.reason)
        : "";
    const decidedEvent: AuditEvent =
      evalResult.verdict.decision === "ALLOW"
        ? {
            id: decidedId,
            query_id: queryId,
            tenant_id: input.ctx.tenant_id,
            database: this.databaseName,
            agent_name: input.ctx.agent_name,
            agent_version: input.ctx.agent_version,
            agent_intent: intent,
            mcp_token_id: input.ctx.mcp_token_id,
            ts: this.now(),
            schema_version: 3,
            event_type: "DECIDED",
            payload: {
              decision: "ALLOW",
              statement_type: evalResult.statementType ?? "UNKNOWN",
              tables_touched: evalResult.tablesTouched,
              dialect: this.dialect.name,
            },
          }
        : {
            id: decidedId,
            query_id: queryId,
            tenant_id: input.ctx.tenant_id,
            database: this.databaseName,
            agent_name: input.ctx.agent_name,
            agent_version: input.ctx.agent_version,
            agent_intent: intent,
            mcp_token_id: input.ctx.mcp_token_id,
            ts: this.now(),
            schema_version: 3,
            event_type: "DECIDED",
            payload: {
              decision: "DENY",
              policy_rule: evalResult.verdict.reason,
              reason: denyMessage,
              statement_type: evalResult.statementType ?? undefined,
              tables_touched:
                evalResult.tablesTouched.length > 0
                  ? evalResult.tablesTouched
                  : undefined,
              dialect: this.dialect.name,
            },
          };
    await this.writeOrThrow(decidedEvent);

    if (evalResult.verdict.decision === "DENY") {
      return {
        allowed: false,
        reason: evalResult.verdict.reason,
        message: denyMessage,
        auditId: decidedId,
      };
    }

    // ── 5. execute (only on ALLOW)
    const execStart = this.now();
    let execResult: ExecutionResult;
    try {
      execResult = await this.executor.execute(input.sql, {
        tenant_id: input.ctx.tenant_id,
        agent_name: input.ctx.agent_name,
        agent_version: input.ctx.agent_version,
      });
    } catch (err) {
      const failed: AuditEvent = {
        id: this.idGen(),
        query_id: queryId,
        tenant_id: input.ctx.tenant_id,
        database: this.databaseName,
        agent_name: input.ctx.agent_name,
        agent_version: input.ctx.agent_version,
        agent_intent: intent,
        mcp_token_id: input.ctx.mcp_token_id,
        ts: this.now(),
        schema_version: 3,
        event_type: "FAILED",
        payload: {
          exec_ms: Math.max(0, this.now() - execStart),
          overhead_ms: Math.max(0, execStart - start),
          error_class: (err as { code?: string })?.code ?? "UNKNOWN",
          error_message: String((err as Error)?.message ?? err).slice(0, 4096),
        },
      };
      // Post-execute audit failure logs but does not throw — the ATTEMPTED+
      // DECIDED rows already prove intent.
      await this.writePostExecBestEffort(failed);

      // Re-throw the underlying execution error (it's an infrastructure /
      // remote failure, not a policy denial).
      throw err;
    }

    const executed: AuditEvent = {
      id: this.idGen(),
      query_id: queryId,
      tenant_id: input.ctx.tenant_id,
      database: this.databaseName,
      agent_name: input.ctx.agent_name,
      agent_version: input.ctx.agent_version,
      agent_intent: intent,
      mcp_token_id: input.ctx.mcp_token_id,
      ts: this.now(),
      schema_version: 3,
      event_type: "EXECUTED",
      payload: {
        exec_ms: Math.max(0, this.now() - execStart),
        overhead_ms: Math.max(0, execStart - start),
        rows_returned: execResult.rows.length,
        rows_affected: execResult.rowCount,
      },
    };
    await this.writePostExecBestEffort(executed);

    return { allowed: true, result: execResult, auditId: decidedId };
  }

  // Pre-execute audit writes are critical-path. A throw here aborts the pipeline.
  private async writeOrThrow(event: AuditEvent): Promise<void> {
    try {
      await this.audit.write(event);
    } catch (err) {
      if (err instanceof AuditUnavailableError) throw err;
      throw new AuditUnavailableError(
        `audit write failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  // Post-execute audit writes are best-effort (per T3). We don't throw,
  // because the ATTEMPTED+DECIDED rows already prove intent.
  private async writePostExecBestEffort(event: AuditEvent): Promise<void> {
    try {
      await this.audit.write(event);
    } catch (err) {
      // Surface to ops via stderr — pino integration belongs to the
      // server package, not the engine library.
      console.error(
        `[engine] post-exec audit write failed for ${event.event_type}:`,
        err,
      );
    }
  }
}

// Stable, AST-agnostic fingerprint. Spec calls for AST normalization
// (literals → ?, sorted aliases) but a content-only hash is acceptable
// for V1 — the moat (cross-customer fingerprint statistics) is a Phase 3
// concern. We hash the parsed-stmts JSON when available, otherwise the raw
// SQL. First 8 bytes of SHA-256 = 16 hex chars to match the zod regex.
function computeFingerprint(sql: string, parseResult: Awaited<ReturnType<Dialect["parse"]>>): string {
  const input = parseResult.ok
    ? JSON.stringify(normalizeForFingerprint(parseResult.ast))
    : sql;
  const digest = createHash("sha256").update(input).digest("hex");
  return digest.slice(0, 16);
}

// Replace literal node values with placeholders so semantically-equivalent
// queries with different literals produce the same fingerprint.
function normalizeForFingerprint(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(normalizeForFingerprint);
  if (typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (obj.A_Const) return { A_Const: "?" };
  if (obj.ParamRef) return { ParamRef: "?" };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    // Drop location fields to make the hash independent of source positions.
    if (k === "location") continue;
    out[k] = normalizeForFingerprint(obj[k]);
  }
  return out;
}

// Fallback messages for rule names that didn't supply their own polished
// sentence on the verdict. Rules SHOULD always supply a `message` — these
// defaults only fire for `internal_error` (synthesized when a rule throws)
// and any future rule that forgets.
function defaultMessageForRule(rule: string): string {
  switch (rule) {
    case "internal_error":
      return (
        "Midplane denied this query because policy evaluation threw " +
        "unexpectedly. The query was audited but not executed; the engine " +
        "logs the underlying error to ops."
      );
    default:
      return `Midplane denied this query (rule: ${rule}).`;
  }
}
