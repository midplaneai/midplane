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
import type { Executor, ExecuteContext, ExecutionResult } from "./executor.ts";
import { maskResultSet } from "./masking/mask-result-set.ts";
import type { ColumnMasks } from "./masking/mask-result-set.ts";
import type { CatalogResolver } from "./masking/catalog.ts";
import { runSourceRewrite } from "./masking/source-rewrite.ts";
import type { SourceRewriter } from "./masking/source-rewrite.ts";
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
  // Per-session read-only ceiling from the cloud per-agent grant. Sourced from
  // the `X-Midplane-Scope` HTTP header at MCP `initialize`, surfaced per-DB by
  // the mcp-server's ctxFor, and read by the table_access rule:
  //   - undefined / "read_write" → no clamp (the table_access policy decides);
  //   - "read"                   → cap this session at read — writes the policy
  //                                would otherwise permit are denied.
  // It only ever NARROWS; it can't widen a table the policy denies. Null/absent
  // for URL-token sessions, self-host owner-all, non-MCP callers, and dry-run.
  scope_max_access?: "read" | "read_write";
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

// The verdict half of the pipeline, with NO execution and NO audit — exactly
// what `Engine.decide()` returns. It is the FIRST half of `handle()` (parse →
// classify → policy), stopped before any Postgres socket is opened. The cloud
// dashboard's policy test surface ("would this SQL be allowed or denied?")
// consumes this; the values are computed by the same guarded parse + the same
// `evaluate()` the live enforcement path runs, so a preview can never drift
// from what `handle()` would decide for the same statement + policy.
export type DecisionPreview = {
  // Uppercase to mirror the engine's internal verdict + the audit `decision`
  // field. The HTTP dry-run layer lowercases it for its wire contract.
  decision: "ALLOW" | "DENY";
  // Wire-level rule name on DENY (e.g. "table_access", "tenant_scope_missing",
  // "parse_error", "internal_error"); null on ALLOW.
  reason: string | null;
  // Polished agent-facing sentence on DENY — IDENTICAL to the `message`
  // `handle()` returns and audits for the same denial; null on ALLOW.
  message: string | null;
  // Canonical statement keyword (SELECT/INSERT/UPDATE/DELETE/…); null only when
  // there were no statements (e.g. a parse failure).
  statementType: string | null;
  // Tables the statement touches, as the audit pipeline records them.
  tablesTouched: string[];
};

// Column-masking configuration for this engine (decision A2: a sibling of the
// access policy, not part of the rules). Absent / empty `columnMasks` = masking
// off = the result-set masker is a true no-op. `resolver` is injected like the
// executor so the engine package needs no DB driver.
export type MaskingConfig = {
  /** "schema.table" -> (column name -> transform). */
  columnMasks: ColumnMasks;
  /** Per-(project|database) secret keying the deterministic transforms. */
  salt: string;
  /** Turns result OIDs into the catalog the masker needs (cached per conn). */
  resolver: CatalogResolver;
  // Optional source-rewrite path (T0). When `enabled`, a masked query is rewritten
  // at the source relation (mask under the computation) on one transaction-scoped
  // client, instead of post-processing the result set — so aggregates over unmasked
  // tables stop being blanket-denied (ISSUE-007). The `rewriter` is the dialect's
  // span-splice + covert-channel gate (postgresSourceRewriter). When disabled, or
  // when the executor has no `withTransaction`, enforcement falls back to the
  // retained post-exec masker (the rollback path) — so this is safe to flip per env.
  sourceRewrite?: {
    enabled: boolean;
    rewriter: SourceRewriter;
  };
};

export interface EngineOptions {
  policy: { rules: Rule[] };
  audit: AuditWriter;
  credentials: CredentialStore;
  executor: Executor;
  // Optional column masking. When set with a non-empty columnMasks, the engine
  // post-processes every ALLOWED result (SELECT and RETURNING) through the
  // fail-closed masker before returning rows to the agent.
  masking?: MaskingConfig;
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
  private readonly masking?: MaskingConfig;
  private readonly credentials: CredentialStore;
  private readonly databaseName: string;
  private readonly dialect: Dialect;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(opts: EngineOptions) {
    this.rules = opts.policy.rules;
    this.audit = opts.audit;
    this.executor = opts.executor;
    this.masking = opts.masking;
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
    //    the agent's intent before any policy runs. The same guarded parse
    //    backs Engine.decide() so dry-run verdicts can't diverge from enforcement.
    const parseResult = await this.parseGuarded(input.sql);

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
    //    Runs AFTER the ATTEMPTED write (above) so a misbehaving rule can
    //    never disappear the query from audit; Engine.decide() reuses this
    //    same guarded evaluation so a dry-run can't disagree with the live
    //    decision.
    const evalResult = this.evaluateGuarded(parseResult, input.ctx);

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

    // ── 5. execute (only on ALLOW). Two enforcement paths, both wrapped so an
    //    infra throw becomes a FAILED audit + re-raise:
    //    • source-rewrite ON (and the executor supports transactions): the masked
    //      query is rewritten at the SOURCE on one transaction-scoped client and
    //      comes back already masked — aggregates over unmasked tables are no longer
    //      blanket-denied (ISSUE-007). A covert-channel / rewrite reject withholds
    //      the rows (column_masking) WITHOUT executing.
    //    • otherwise (rewrite disabled, or the executor has no withTransaction):
    //      plain execute, then the retained post-exec masker (5b) transforms the
    //      masked columns OR rejects. This is the fallback / rollback path.
    const execStart = this.now();
    const execCtx: ExecuteContext = {
      tenant_id: input.ctx.tenant_id,
      agent_name: input.ctx.agent_name,
      agent_version: input.ctx.agent_version,
    };
    let execResult: ExecutionResult;
    let columnsMasked: string[] | undefined;
    let maskingRejectReason: string | undefined;
    try {
      const sr = await this.applySourceRewrite(input.sql, execCtx);
      if (sr.handled) {
        execResult = sr.result;
        columnsMasked = sr.columnsMasked;
        maskingRejectReason = sr.rejectReason;
      } else {
        // ── 5b. fallback: plain execute + retained post-exec masker (fail-closed).
        execResult = await this.executor.execute(input.sql, execCtx);
        if (this.masking && this.masking.columnMasks.size > 0) {
          const masked = await this.applyMasking(execResult);
          if (masked.ok) {
            columnsMasked = masked.columnsMasked.length ? masked.columnsMasked : undefined;
          } else {
            maskingRejectReason = masked.reason;
          }
        }
      }
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

    // EXECUTED is always written (the query DID run), carrying the masking
    // outcome. On a masking reject we then return a structured denial below.
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
        ...(columnsMasked ? { columns_masked: columnsMasked } : {}),
        ...(maskingRejectReason
          ? { masking_rejected: true, masking_reason: maskingRejectReason.slice(0, 512) }
          : {}),
      },
    };
    await this.writePostExecBestEffort(executed);

    if (maskingRejectReason) {
      return {
        allowed: false,
        reason: "column_masking",
        message: maskingRejectReason,
        auditId: decidedId,
      };
    }

    return { allowed: true, result: execResult, auditId: decidedId };
  }

  // Source-rewrite enforcement path (T0). Active only when masking is configured
  // with `sourceRewrite.enabled`. Rewrites the masked query at the source on ONE
  // transaction-scoped client: SHAPE gate (covert-channel, AST-only) → SHADOW scan
  // + by-name resolve + span-splice rewrite → execute, all fail-closed. Returns
  // { handled:false } when source-rewrite is off OR the executor can't open a
  // transaction — the caller then falls back to plain execute + the post-exec
  // masker (the rollback path), so flipping the flag is always safe.
  private async applySourceRewrite(
    sql: string,
    execCtx: ExecuteContext,
  ): Promise<
    | { handled: false }
    | { handled: true; result: ExecutionResult; columnsMasked?: string[]; rejectReason?: string }
  > {
    const m = this.masking;
    if (!m || m.columnMasks.size === 0 || !m.sourceRewrite?.enabled) {
      return { handled: false };
    }
    const rewriter = m.sourceRewrite.rewriter;
    // SHAPE gate (covert-channel) — AST-only, before opening a transaction, so an
    // off-allowlist function (query_to_xml, dblink, a UDF, current_setting) is
    // rejected without executing anything.
    const shape = rewriter.checkShape(sql);
    if (!shape.ok) {
      return { handled: true, result: { rows: [], rowCount: 0 }, rejectReason: shape.reason };
    }
    const rw = await runSourceRewrite(sql, execCtx, {
      executor: this.executor,
      rewriter,
      columnMasks: m.columnMasks,
      salt: m.salt,
      shadowNames: shape.allowlistedFns,
    });
    if (rw === null) return { handled: false }; // executor has no withTransaction -> fall back
    if (!rw.ok) {
      return { handled: true, result: { rows: [], rowCount: 0 }, rejectReason: rw.reason };
    }
    return {
      handled: true,
      result: rw.result,
      columnsMasked: rw.maskedColumns.length ? [...new Set(rw.maskedColumns)] : undefined,
    };
  }

  // Post-execute column masking. Maps each output column to its source via the
  // driver's RowDescription provenance (execResult.fields) and either transforms
  // masked values, passes through, or rejects (fail-closed). On a retryable
  // (cache-stale) reject it invalidates the catalog and retries ONCE. On success
  // it replaces execResult.rows in place and returns the masked column names.
  private async applyMasking(
    execResult: ExecutionResult,
  ): Promise<{ ok: true; columnsMasked: string[] } | { ok: false; reason: string }> {
    const m = this.masking!;
    const oids = (execResult.fields ?? []).map((f) => f.tableOid);

    const runOnce = async () =>
      maskResultSet({
        rows: execResult.rows,
        fields: execResult.fields,
        columnMasks: m.columnMasks,
        catalog: await m.resolver.resolve(oids),
        salt: m.salt,
      });

    let outcome = await runOnce();
    if (!outcome.ok && outcome.retryable) {
      m.resolver.invalidate();
      outcome = await runOnce();
    }
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    execResult.rows = outcome.rows;
    return { ok: true, columnsMasked: outcome.maskedColumns };
  }

  // Compute the policy verdict for a statement WITHOUT auditing or executing
  // it. This is the first half of `handle()` — parse → classify → policy —
  // stopped before the ATTEMPTED write and before any Postgres connection is
  // opened. It exists so the cloud's policy-test surface gets its "allow or
  // deny?" answer from the SAME code that enforces policy at query time: it
  // runs `parseGuarded` + `evaluateGuarded`, the exact two primitives
  // `handle()` runs, over the engine's OWN rules + dialect (so a hot-swapped
  // policy is reflected immediately). It never touches `this.executor`, so it
  // can never open a socket to the customer database.
  //
  // Like `handle()`, this never throws on bad SQL: an unparseable statement
  // comes back as a `parse_error` DENY (the parse_error rule's job), and a
  // rule that throws comes back as an `internal_error` DENY — identical to
  // what the live path would decide and audit.
  async decide(input: { sql: string; ctx: EngineContext }): Promise<DecisionPreview> {
    const parseResult = await this.parseGuarded(input.sql);
    const evalResult = this.evaluateGuarded(parseResult, input.ctx);
    if (evalResult.verdict.decision === "DENY") {
      return {
        decision: "DENY",
        reason: evalResult.verdict.reason,
        message:
          evalResult.verdict.message ??
          defaultMessageForRule(evalResult.verdict.reason),
        statementType: evalResult.statementType,
        tablesTouched: evalResult.tablesTouched,
      };
    }
    return {
      decision: "ALLOW",
      reason: null,
      message: null,
      statementType: evalResult.statementType,
      tablesTouched: evalResult.tablesTouched,
    };
  }

  // Parse, converting a WASM crash into a synthetic parse-failure ParseResult
  // instead of throwing. Shared by `handle()` (which writes ATTEMPTED before
  // calling `evaluateGuarded`) and `decide()` so both classify identically.
  private async parseGuarded(
    sql: string,
  ): Promise<Awaited<ReturnType<Dialect["parse"]>>> {
    try {
      return await this.dialect.parse(sql);
    } catch (err) {
      return {
        ok: false,
        error: `parser_crashed: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  }

  // Run all policy rules over the parsed statement, converting any rule throw
  // (or a dialect normalize() throw) into a clean internal_error DENY rather
  // than an unhandled exception. The single decision brain — `handle()` and
  // `decide()` both route through here, so dry-run verdicts cannot diverge
  // from enforcement.
  private evaluateGuarded(
    parseResult: Awaited<ReturnType<Dialect["parse"]>>,
    ctx: EngineContext,
  ): ReturnType<typeof evaluate> {
    try {
      return evaluate({
        parse: parseResult,
        ctx,
        rules: this.rules,
        dialect: this.dialect,
      });
    } catch (err) {
      console.error("[engine] policy evaluation threw:", err);
      return {
        verdict: { decision: "DENY", reason: "internal_error" },
        statementType: null,
        tablesTouched: [],
      };
    }
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
