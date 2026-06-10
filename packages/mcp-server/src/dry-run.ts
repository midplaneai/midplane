// POST /admin/dry-run — "would this SQL be allowed or denied?" for the cloud
// dashboard's policy test surface.
//
// HARD CONSTRAINT (single decision brain): this file NEVER decides allow/deny
// itself. Every verdict comes from `engine.decide()` — the first half of the
// live enforcement pipeline (parse → classify → policy), stopped before any
// Postgres socket is opened. This module only:
//   1. validates the request shape,
//   2. synthesizes a representative SQL statement per probe (so the cloud can
//      ask about a (table, action) without writing SQL), and
//   3. LABELS the engine's verdict (decision / reason / matched_rule / tables /
//      action) for the wire.
// The labels (`matched_rule`, the human `reason`) are derived from the same
// `resolveTableAccessForName` / `resolveTenantColumn` the live rules use, so a
// label can never contradict the verdict the engine returned.
//
// It also never opens a connection to the customer database: `engine.decide()`
// touches only the parser + policy rules, never `this.executor`.

import { z } from "zod";
import { createHash } from "node:crypto";
import {
  resolveTableAccessForName,
  resolveTenantColumn,
  type DecisionPreview,
  type Engine,
  type EngineContext,
  type TableAccessConfig,
  type TableAccessResolution,
  type TenantScopeConfig,
} from "@midplane/engine";

// One HTTP call may carry many probes; cap so a pathological request can't pin
// the parser. Beyond the table cap we evaluate the first 50 distinct tables'
// probes and flag `truncated` (+ `total_tables`) so the cloud knows it's a
// partial answer rather than silently dropping the rest.
const MAX_PROBES = 250;
const MAX_TABLES = 50;

// Default synthetic tenant when the caller omits `tenant_context`. The point of
// a synthetic value is that it matches nothing real — a probe never reads a
// customer's actual rows even in principle (it's never executed anyway).
const DEFAULT_PROBE_TENANT = "__midplane_probe__";

// A throwaway column for an UNSCOPED write probe's syntactic skeleton — table
// access only cares about the target table, so any identifier parses fine. It
// never reaches a database.
const PROBE_COLUMN = "_midplane_probe";

// Probe tables go straight into synthesized SQL, so they must be plain
// identifiers (optionally schema-qualified). Anything outside this set is a 400
// rather than a chance to emit malformed/injected SQL.
const TABLE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

export type ProbeAction = "select" | "insert" | "update" | "delete";

export interface Probe {
  table: string;
  action: ProbeAction;
  cross_tenant?: boolean;
}

// One verdict in the response. Exactly one of `probe` / `sql` is present,
// echoing whichever input produced it.
export interface DryRunVerdict {
  probe?: Probe;
  sql?: string;
  decision: "allow" | "deny";
  reason: string; // short human sentence
  matched_rule: string; // e.g. "table:public.customers→deny", "default:read", "tenant_scope:orders.account_id"
  tables: string[]; // tables the statement touches (post-scoping)
  action: string; // classified statement keyword (SELECT/INSERT/UPDATE/DELETE/…)
}

export interface DryRunResponse {
  verdicts: DryRunVerdict[];
  truncated: boolean;
  total_tables?: number; // present only when truncated
  // Hash of the currently-loaded policy for THIS database, so the cloud can
  // detect it's testing against a stale policy snapshot.
  policy_hash: string;
}

// 400-class failures (bad request shape, unknown database, unparseable custom
// SQL). The HTTP layer maps this to a 400 with a parseable JSON error body;
// any OTHER throw is an unexpected bug and maps to 500.
export class DryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DryRunError";
  }
}

// The live per-database view the dry-run needs. `engine` is the SAME engine the
// MCP `query` tool drives, so `engine.decide()` reflects the current
// (hot-swappable) policy. `tableAccess` / `tenantScope` are the live holder
// pointers — read for synthetic-SQL column resolution and verdict labelling.
export interface DryRunTarget {
  engine: Engine;
  tableAccess: TableAccessConfig | undefined;
  tenantScope: TenantScopeConfig;
  ctxBase: EngineContext;
}

const ProbeSchema = z.object({
  table: z.string().min(1),
  action: z.enum(["select", "insert", "update", "delete"]),
  cross_tenant: z.boolean().optional(),
});

const RequestSchema = z.object({
  database: z.string().min(1),
  tenant_context: z.object({ value: z.string().min(1) }).optional(),
  probes: z.array(ProbeSchema).optional(),
  sql: z.string().min(1).optional(),
});

export type DryRunRequest = z.infer<typeof RequestSchema>;

// Validate the request body in isolation (so the registry can resolve the
// `database` before building a target). Enforces the "exactly one of probes |
// sql" rule the schema can't express on its own. Throws DryRunError → 400.
export function validateDryRunRequest(body: unknown): DryRunRequest {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new DryRunError(
      `invalid dry-run request: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const req = parsed.data;
  const hasProbes = req.probes !== undefined;
  const hasSql = req.sql !== undefined;
  if (hasProbes === hasSql) {
    throw new DryRunError(
      "request must contain exactly one of `probes` or `sql` (got " +
        (hasProbes ? "both" : "neither") +
        ")",
    );
  }
  return req;
}

// Run a validated request against a resolved target. The HTTP/registry layer
// has already mapped `database` → target; this is the pure evaluation core.
export async function executeDryRun(
  target: DryRunTarget,
  req: DryRunRequest,
): Promise<DryRunResponse> {
  const tenantValue = req.tenant_context?.value ?? DEFAULT_PROBE_TENANT;
  // The engine's tenant_scope rule compares predicate literals against
  // ctx.tenant_id; bind the synthetic tenant here so a correctly-scoped probe
  // (predicate = tenantValue) allows and a cross-tenant probe (a different
  // literal) denies wherever scoping is configured.
  const ctx: EngineContext = {
    ...target.ctxBase,
    tenant_id: tenantValue,
    agent_name: null,
    agent_version: null,
    mcp_token_id: null,
  };
  const policy_hash = computePolicyHash(target);

  if (req.sql !== undefined) {
    const verdict = await decideCustomSql(target, ctx, req.sql);
    return { verdicts: [verdict], truncated: false, policy_hash };
  }

  return runProbes(target, ctx, tenantValue, req.probes!, policy_hash);
}

// ── custom SQL variant ───────────────────────────────────────────────────────

async function decideCustomSql(
  target: DryRunTarget,
  ctx: EngineContext,
  sql: string,
): Promise<DryRunVerdict> {
  const preview = await target.engine.decide({ sql, ctx });
  // A custom statement that doesn't parse is a user input error on the cloud's
  // test box (distinct from "valid SQL that policy denies"), so surface it as a
  // 400 rather than a parse_error verdict — same convention as /admin/policy.
  if (preview.decision === "DENY" && preview.reason === "parse_error") {
    throw new DryRunError(
      `could not parse SQL: ${preview.message ?? "unparseable statement"}`,
    );
  }
  return toVerdict(target, preview, { sql });
}

// ── probe variant ────────────────────────────────────────────────────────────

async function runProbes(
  target: DryRunTarget,
  ctx: EngineContext,
  tenantValue: string,
  probes: Probe[],
  policy_hash: string,
): Promise<DryRunResponse> {
  for (const p of probes) {
    if (!TABLE_IDENT_RE.test(p.table)) {
      throw new DryRunError(
        `probe table "${p.table}" is not a valid identifier (bare or schema.table)`,
      );
    }
  }

  // Distinct tables in first-appearance order — the table cap keeps the first
  // 50 of these.
  const distinctTables: string[] = [];
  for (const p of probes) {
    if (!distinctTables.includes(p.table)) distinctTables.push(p.table);
  }

  let kept = probes;
  let truncated = false;
  let total_tables: number | undefined;

  if (distinctTables.length > MAX_TABLES) {
    const allowed = new Set(distinctTables.slice(0, MAX_TABLES));
    kept = probes.filter((p) => allowed.has(p.table));
    truncated = true;
    total_tables = distinctTables.length;
  }
  if (kept.length > MAX_PROBES) {
    kept = kept.slice(0, MAX_PROBES);
    truncated = true;
    if (total_tables === undefined) total_tables = distinctTables.length;
  }

  const verdicts: DryRunVerdict[] = [];
  // Sequential so verdicts come back in probe order (a documented guarantee)
  // and so we never fan out parser work unboundedly.
  for (const p of kept) {
    const sql = buildProbeSql(target, p, tenantValue);
    const preview = await target.engine.decide({ sql, ctx });
    verdicts.push(toVerdict(target, preview, { probe: p }));
  }

  return {
    verdicts,
    truncated,
    ...(total_tables !== undefined ? { total_tables } : {}),
    policy_hash,
  };
}

// Synthesize a representative statement for a (table, action) probe. When the
// table is tenant-scoped, bind the tenant predicate: to ctx.tenant_id for a
// normal probe (so a correctly-scoped query is what we test), or to a DIFFERENT
// literal for `cross_tenant` (so we test "reach another tenant's rows", which
// must deny wherever scoping is configured). For an unscoped table there is no
// predicate to bind, and `cross_tenant` is a no-op — the normal policy decision
// stands (an allow there is exactly the missing-scope the cloud UI surfaces).
function buildProbeSql(
  target: DryRunTarget,
  probe: Probe,
  tenantValue: string,
): string {
  const table = probe.table; // validated identifier
  const column = resolveTenantColumn(bareName(table), target.tenantScope);
  const bound = probe.cross_tenant ? crossTenantValue(tenantValue) : tenantValue;
  const lit = sqlString(bound);

  switch (probe.action) {
    case "select":
      return column
        ? `SELECT * FROM ${table} WHERE ${column} = ${lit}`
        : `SELECT * FROM ${table}`;
    case "delete":
      return column
        ? `DELETE FROM ${table} WHERE ${column} = ${lit}`
        : `DELETE FROM ${table}`;
    case "update":
      // SET targets an arbitrary column (tenant_scope ignores SET; table_access
      // only cares about the target table). The WHERE clause carries the scope
      // predicate when the table is scoped.
      return column
        ? `UPDATE ${table} SET ${PROBE_COLUMN} = NULL WHERE ${column} = ${lit}`
        : `UPDATE ${table} SET ${PROBE_COLUMN} = NULL`;
    case "insert":
      // A scoped INSERT must name the tenant column with the bound literal; an
      // unscoped one just needs a syntactically valid column list.
      return column
        ? `INSERT INTO ${table} (${column}) VALUES (${lit})`
        : `INSERT INTO ${table} (${PROBE_COLUMN}) VALUES (1)`;
  }
}

// ── verdict labelling ────────────────────────────────────────────────────────

// Map an engine DecisionPreview to the wire verdict, echoing whichever input
// produced it. The decision/action/tables come straight from the engine; only
// the `reason` sentence and `matched_rule` label are computed here, from the
// same resolvers the rules use.
function toVerdict(
  target: DryRunTarget,
  preview: DecisionPreview,
  echo: { probe?: Probe } | { sql: string },
): DryRunVerdict {
  const probe = "probe" in echo ? echo.probe : undefined;
  const { matched_rule, reason } = label(target, preview, probe);
  return {
    ...(probe ? { probe } : {}),
    ...("sql" in echo ? { sql: echo.sql } : {}),
    decision: preview.decision === "ALLOW" ? "allow" : "deny",
    reason,
    matched_rule,
    tables: preview.tablesTouched,
    action:
      preview.statementType ??
      (probe ? probe.action.toUpperCase() : "UNKNOWN"),
  };
}

function label(
  target: DryRunTarget,
  preview: DecisionPreview,
  probe: Probe | undefined,
): { matched_rule: string; reason: string } {
  if (preview.decision === "ALLOW") {
    // The positive grant for an allowed statement is its table_access
    // resolution. For a probe we know the single table; for custom SQL we
    // report a generic allow (the engine cleared every rule).
    if (probe) {
      const res = resolveTableAccessForName(probe.table, target.tableAccess);
      return {
        matched_rule: tableAccessLabel(res),
        reason: `Allowed — ${probe.action} on \`${probe.table}\` is permitted by policy.`,
      };
    }
    return {
      matched_rule: "allow",
      reason: "Allowed — the statement is permitted by policy.",
    };
  }

  // DENY. The wire rule name comes from the engine; refine it into a specific
  // matched_rule when we have the probe context to do so.
  const rule = preview.reason ?? "unknown";
  switch (rule) {
    case "table_access": {
      if (probe) {
        const res = resolveTableAccessForName(probe.table, target.tableAccess);
        return {
          matched_rule: tableAccessLabel(res),
          reason: `Denied — \`${probe.table}\` resolves to \`${res.level}\`; ${probe.action} is not permitted.`,
        };
      }
      return { matched_rule: "table_access", reason: shorten(preview.message) };
    }
    case "tenant_scope_missing": {
      if (probe) {
        const rel = bareName(probe.table);
        const column = resolveTenantColumn(rel, target.tenantScope);
        if (column) {
          const why = probe.cross_tenant
            ? `cross-tenant ${probe.action} on \`${probe.table}\` is blocked; rows are scoped by \`${column}\``
            : `\`${probe.table}\` requires a \`${column} = <tenant_id>\` predicate`;
          return {
            matched_rule: `tenant_scope:${rel}.${column}`,
            reason: `Denied — ${why}.`,
          };
        }
      }
      return {
        matched_rule: "tenant_scope_missing",
        reason: shorten(preview.message),
      };
    }
    case "multi_statement":
      return {
        matched_rule: "multi_statement",
        reason: "Denied — multiple statements in one query are not allowed.",
      };
    case "parse_error":
      return { matched_rule: "parse_error", reason: shorten(preview.message) };
    default:
      // internal_error and any future rule.
      return { matched_rule: rule, reason: shorten(preview.message) };
  }
}

function tableAccessLabel(res: TableAccessResolution): string {
  switch (res.source) {
    case "table":
      return `table:${res.key}→${res.level}`;
    case "information_schema":
      return "information_schema:read";
    case "default":
      return `default:${res.level}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Stable 16-hex-char hash of the database's currently-loaded policy. Canonical
// JSON (sorted keys) so re-ordering YAML doesn't change it; matches the
// engine's fingerprint width.
function computePolicyHash(target: DryRunTarget): string {
  const ta = target.tableAccess;
  const ts = target.tenantScope;
  const canonical = JSON.stringify({
    table_access: ta
      ? { default: ta.default, tables: sortedRecord(ta.tables) }
      : null,
    tenant_scope: {
      column: ts.defaultColumn,
      overrides: sortedRecord(ts.overrides),
      exempt: [...ts.exempt].sort(),
    },
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out;
}

// `public.users` → `users`. tenant_scope keys are bare relnames.
function bareName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

// A value guaranteed different from `tenantValue` (appending always lengthens
// it), so a cross-tenant probe's predicate never matches the bound tenant.
function crossTenantValue(tenantValue: string): string {
  return `${tenantValue}__midplane_other_tenant__`;
}

// SQL single-quoted literal with `'` doubled. The result is never executed —
// this only keeps the synthesized statement parseable and makes the parser
// extract back the exact bound value for the tenant_scope predicate check.
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Trim a polished (often multi-sentence) engine message down to its first
// sentence for the dry-run's short `reason`. Falls back to a generic line.
function shorten(message: string | null): string {
  if (!message) return "Denied by policy.";
  const firstStop = message.indexOf(". ");
  return firstStop > 0 ? message.slice(0, firstStop + 1) : message;
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
