// table_access rule.
//
// Per-table read/read_write policy. Consumes the dialect-agnostic IR
// (NormalizedProgram.accessChecks) — a sequence of write/read/no_target checks
// emitted by the dialect's normalize() in the dialect's own walk order. The
// rule replays them and denies on the FIRST failure, so the surfaced cause (and
// its message) matches what a single recursive AST walk would have produced.
// The AST-level detection (writes hidden in CTEs / subqueries / UNION arms /
// JOINs, CTE-name shadowing, DROP/GRANT object lists, the search_path tamper
// guard) all lives in the adapter now; this rule is dialect-blind.
//
// Permission levels:
//   "deny"       — neither read nor write allowed
//   "read"       — SELECT allowed; any write denied
//   "read_write" — both allowed
//
// Schema resolution mirrors how Postgres's default search_path resolves bare
// names to `public.<table>`. Lookup order in resolvePermission:
//   1. information_schema → unconditional `read` (discovery carve-out).
//   2. schema-qualified ref → try `<schema>.<name>`.
//   3. bare ref → try `public.<name>` (implicit-schema fallback) before bare.
//   4. bare `<name>` key.
//   5. `default`.
// When no policy is supplied, the rule falls back to legacy "deny all writes"
// (`{ default: "read", tables: {} }`) — same V1 trust posture out of the box.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type { NormalizedProgram } from "../../ir/types.ts";
import { PolicyRule } from "../../audit/types.ts";

export type TableAccessLevel = "deny" | "read" | "read_write";

export interface TableAccessConfig {
  default: TableAccessLevel;
  tables: Record<string, TableAccessLevel>;
}

// No-YAML default: SELECTs on any table allow; no table is read_write, so every
// write denies regardless of target. Identical to V1.
const LEGACY_NO_YAML_CONFIG: TableAccessConfig = {
  default: "read",
  tables: {},
};

interface TableRef {
  schema: string | null;
  relname: string;
}

// Why a query was denied. The rule reports the first failing check so the
// agent's surfaced message names a specific reason rather than a generic one.
type DenialCause =
  | { kind: "write_blocked"; table: string; resolved: TableAccessLevel }
  | { kind: "read_blocked"; table: string; resolved: TableAccessLevel }
  // The table_access POLICY permits the write, but this session's credential
  // is scoped read-only by the cloud per-agent grant (ctx.scope_max_access ===
  // "read"). Distinct from write_blocked so the message doesn't tell the
  // operator to mark a table read_write when it already is.
  | { kind: "scope_read_only"; table: string }
  | { kind: "no_target"; statement: string };

// Per-session access ceiling carried on the EngineContext. The cloud proxy sets
// it from the credential's per-agent grant (X-Midplane-Scope header, frozen at
// MCP initialize and surfaced per-DB by the mcp-server's ctxFor):
//   - "read_write" / undefined → no clamp (the policy decides).
//   - "read"                   → cap this session at read; writes the policy
//                                would otherwise permit are denied.
// The clamp only ever NARROWS — it can't widen a table the policy denies.
type ScopeCeiling = "read" | "read_write" | undefined;

// Accepts either a static TableAccessConfig (snapshot at construction) or a
// getter that returns the current config on each evaluation. The getter form
// lets the mcp-server hot-swap policy via POST /admin/policy without rebuilding
// the engine: the rule reads the holder's pointer once per query.
type TableAccessConfigSource =
  | TableAccessConfig
  | (() => TableAccessConfig | undefined)
  | undefined;

export function tableAccess(source?: TableAccessConfigSource): Rule {
  const resolveConfig = (): TableAccessConfig | undefined =>
    typeof source === "function" ? source() : source;
  return {
    name: PolicyRule.TABLE_ACCESS,
    // Replay the adapter's DFS-ordered access checks; deny on the first failure.
    // The adapter already excluded CTE-shadowed reads and emitted no_target for
    // state-mutating statements with no per-table target.
    evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns this case
      const cfg = resolveConfig() ?? LEGACY_NO_YAML_CONFIG;
      // Per-session read-only ceiling from the cloud per-agent grant. "read"
      // caps writes the policy would otherwise allow; "read_write"/undefined =
      // no clamp. Read AFTER cfg so a clamp only narrows the resolved policy.
      const ceiling = (rctx.ctx as { scope_max_access?: ScopeCeiling })
        .scope_max_access;
      for (const c of program.accessChecks) {
        let cause: DenialCause | null = null;
        if (c.kind === "no_target") {
          cause = { kind: "no_target", statement: c.keyword };
        } else if (c.kind === "write") {
          const resolved = resolvePermission(c.ref, cfg);
          if (resolved !== "read_write") {
            cause = { kind: "write_blocked", table: displayName(c.ref), resolved };
          } else if (ceiling === "read") {
            // Policy permits the write, but the credential is scoped read-only.
            cause = { kind: "scope_read_only", table: displayName(c.ref) };
          }
        } else {
          const resolved = resolvePermission(c.ref, cfg);
          if (resolved === "deny") {
            cause = { kind: "read_blocked", table: displayName(c.ref), resolved };
          }
        }
        if (cause) {
          return {
            decision: "DENY",
            reason: PolicyRule.TABLE_ACCESS,
            message: messageFor(cause),
          };
        }
      }
      return { decision: "ALLOW" };
    },
  };
}

function messageFor(cause: DenialCause): string {
  switch (cause.kind) {
    case "write_blocked":
      return (
        `Midplane denied this query because writes to table \`${cause.table}\` ` +
        `are not allowed by the table-access policy ` +
        `(\`${cause.table}\` resolves to \`${cause.resolved}\`; mark it ` +
        `\`read_write\` in your MIDPLANE_POLICY_FILE to grant writes).`
      );
    case "read_blocked":
      return (
        `Midplane denied this query because reads from table \`${cause.table}\` ` +
        `are not allowed by the table-access policy ` +
        `(\`${cause.table}\` resolves to \`${cause.resolved}\`; mark it ` +
        `\`read\` or \`read_write\` to grant access).`
      );
    case "scope_read_only":
      return (
        `Midplane denied this write to \`${cause.table}\` because this agent's ` +
        `credential is scoped to read-only access for this database. Grant ` +
        `write access to this database in the consent screen (interactive ` +
        `agents) or the token's scope (API tokens) to allow writes.`
      );
    case "no_target":
      return (
        `Midplane denied this query because the ${cause.statement} statement ` +
        `has no per-table target the table-access policy can grant. ` +
        `Side-effect statements (CALL, EXECUTE, NOTIFY, LISTEN, UNLISTEN, ` +
        `LOCK, COPY, DO, SET, CREATE/DROP/GRANT on non-table objects) deny ` +
        `regardless of YAML config.`
      );
  }
}

function displayName(ref: TableRef): string {
  return ref.schema !== null ? `${ref.schema}.${ref.relname}` : ref.relname;
}

// How a table's permission level was decided. Beyond the level itself, this
// names WHICH key resolved it so callers (the cloud dry-run's `matched_rule`)
// can say "table:public.customers→deny" vs "default:read" vs the
// information_schema carve-out. The rule itself only reads `.level`; the
// attribution is free metadata the dry-run consumes.
export interface TableAccessResolution {
  level: TableAccessLevel;
  source: "table" | "default" | "information_schema";
  // The config key that matched, for source === "table" (e.g. "public.users"
  // or a bare "users"); null for "default" and "information_schema".
  key: string | null;
}

function resolvePermission(ref: TableRef, cfg: TableAccessConfig): TableAccessLevel {
  return resolveDetailed(ref, cfg).level;
}

// The single resolution implementation. `resolvePermission` (used by the rule's
// allow/deny decision) and `resolveTableAccessForName` (used by the dry-run's
// label) both go through this, so a label can never disagree with the verdict.
function resolveDetailed(ref: TableRef, cfg: TableAccessConfig): TableAccessResolution {
  // information_schema is a read-only set of SQL-standard views over schema (not
  // row data). Granting unconditional `read` is structurally required: agents on
  // default-deny tokens need it to discover what tables exist (the MCP
  // list_tables / describe_table tools query information_schema). Placed before
  // the qualified lookup so an explicit `information_schema.*: deny` can't lock
  // discovery out. pg_catalog is intentionally NOT carved out — it exposes
  // pg_roles, pg_proc bodies, pg_settings, etc. and stays subject to policy.
  if (ref.schema === "information_schema") {
    return { level: "read", source: "information_schema", key: null };
  }
  if (ref.schema !== null) {
    const qualified = `${ref.schema}.${ref.relname}`;
    if (Object.prototype.hasOwnProperty.call(cfg.tables, qualified)) {
      return { level: cfg.tables[qualified]!, source: "table", key: qualified };
    }
  } else {
    // Bare reference. Postgres's default search_path resolves these to
    // `public.<name>`, and operators writing per-table policy use the canonical
    // schema-qualified form (`public.users`). Try `public.<name>` before the
    // bare key so the two match without forcing operators to double-list.
    const publicQualified = `public.${ref.relname}`;
    if (Object.prototype.hasOwnProperty.call(cfg.tables, publicQualified)) {
      return { level: cfg.tables[publicQualified]!, source: "table", key: publicQualified };
    }
  }
  if (Object.prototype.hasOwnProperty.call(cfg.tables, ref.relname)) {
    return { level: cfg.tables[ref.relname]!, source: "table", key: ref.relname };
  }
  return { level: cfg.default, source: "default", key: null };
}

// Resolve a table NAME (bare `users` or schema-qualified `public.users`)
// against a table_access config, returning the level AND how it resolved.
// Shares `resolveDetailed` with the live rule, so the dry-run's `matched_rule`
// label is guaranteed consistent with the actual table_access verdict. A
// missing config falls back to the no-YAML default (read everything, write
// nothing) — exactly what the rule does for an engine booted without YAML.
export function resolveTableAccessForName(
  tableName: string,
  cfg: TableAccessConfig | undefined,
): TableAccessResolution {
  const dot = tableName.lastIndexOf(".");
  const ref: TableRef =
    dot >= 0
      ? { schema: tableName.slice(0, dot), relname: tableName.slice(dot + 1) }
      : { schema: null, relname: tableName };
  return resolveDetailed(ref, cfg ?? LEGACY_NO_YAML_CONFIG);
}
