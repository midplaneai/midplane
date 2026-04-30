// table_access rule.
//
// Per-table read/read_write policy. Replaces the V1 binary
// writes_require_approval sentinel. Recursive AST detection: writes
// hidden in CTEs / subqueries / UNION arms / JOINs are detected at the
// inner write node and checked against the target table's permission.
//
// Permission levels:
//   "deny"       — neither read nor write allowed
//   "read"       — SELECT allowed; any write denied
//   "read_write" — both allowed
//
// A query is denied if any referenced table fails its required
// permission. Read-position tables checked against `read`; write-target
// tables checked against `read_write`.
//
// Schema resolution mirrors how Postgres's default search_path
// (`"$user", public`) resolves bare names to `public.<table>` in the
// 99% case. Lookup order:
//   1. If ref is schema-qualified (`public.users`), try `<schema>.<name>` first.
//   2. If ref is bare (`users`), try `public.<name>` as the implicit-schema
//      fallback before the bare key — so policies written in canonical
//      form (`public.users`) match agent SQL that uses bare names.
//   3. Try the bare `<name>` key (matches both bare refs and qualified
//      refs whose schema-qualified key is absent).
//   4. Fall through to `default`.
//
// Executor contract: the engine's "bare → public.<name>" assumption
// MUST be a guarantee at execution time, not a guess. Executors are
// expected to pin the connection's search_path to `public` (PgPoolExecutor
// does this via the libpq `options` startup parameter) so the role's
// default search_path can't redirect a bare ref to a different schema
// while policy authorized it against `public.X`. To keep the pin
// tamper-proof, `VariableSetStmt` is in WRITE_STATEMENT_KINDS — any
// `SET search_path = ...` from agent SQL denies as no_target, so an
// agent can't desync the search_path on a pooled connection.
// When no policy is supplied, the rule falls back to legacy "deny all
// writes" behavior — equivalent to `{ default: "read", tables: {} }` so
// SELECTs allow but every write (no table is `read_write`) denies. Same
// V1 trust posture out of the box.
//
// Side-effecting statements that don't carry an extractable table
// target (DO blocks, NOTIFY/LISTEN/UNLISTEN, EXECUTE, CALL, CREATE
// SCHEMA/ROLE/DATABASE/FUNCTION, GRANT/REVOKE on non-table objects)
// always deny — no per-table key can grant `read_write` to "no
// table", so they remain outside the read-only contract.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

export type TableAccessLevel = "deny" | "read" | "read_write";

export interface TableAccessConfig {
  default: TableAccessLevel;
  tables: Record<string, TableAccessLevel>;
}

// No-YAML default: SELECTs on any table allow; no table is read_write,
// so every write denies regardless of target. Identical to V1.
const LEGACY_NO_YAML_CONFIG: TableAccessConfig = {
  default: "read",
  tables: {},
};

// Statement kinds that mutate state (data, schema, session, server).
// A statement of one of these kinds requires `read_write` on every
// extracted target table; if no target is extractable, deny outright.
const WRITE_STATEMENT_KINDS = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "DropStmt",
  "TruncateStmt",
  "AlterTableStmt",
  "AlterDomainStmt",
  "GrantStmt",
  "GrantRoleStmt",
  "RevokeStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSchemaStmt",
  "CreateRoleStmt",
  "CreateFunctionStmt",
  "CreatedbStmt",
  "ExecuteStmt",
  "CallStmt",
  "CopyStmt",
  "DoStmt",
  "ViewStmt",
  "IndexStmt",
  "RuleStmt",
  "RefreshMatViewStmt",
  "NotifyStmt",
  "ListenStmt",
  "UnlistenStmt",
  "LockStmt",
  // `SET search_path = ...` would let an agent redirect bare-name table
  // resolution on the pooled connection, breaking the policy's
  // "bare → public.<name>" guarantee. No per-table target is grantable,
  // so it falls through to no_target denial for every SET (including
  // benign ones like SET timezone — the YAML can't grant any of them
  // safely, and SET is rarely needed in agent SQL).
  "VariableSetStmt",
]);

interface TableRef {
  schema: string | null;
  relname: string;
}

// Why a query was denied. The rule reports the first failing case so the
// agent's surfaced message names a specific reason rather than a generic one.
type DenialCause =
  | { kind: "write_blocked"; table: string; resolved: TableAccessLevel }
  | { kind: "read_blocked"; table: string; resolved: TableAccessLevel }
  | { kind: "no_target"; statement: string };

export function tableAccess(config?: TableAccessConfig): Rule {
  return {
    name: PolicyRule.TABLE_ACCESS,
    reset() {},
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns
      const cfg = config ?? LEGACY_NO_YAML_CONFIG;

      let cause: DenialCause | null = null;
      const flag = (c: DenialCause) => {
        if (cause === null) cause = c;
      };

      visitForTableAccess(rctx.parse.ast.stmts, cfg, flag);

      if (cause === null) return { decision: "ALLOW" };
      return {
        decision: "DENY",
        reason: PolicyRule.TABLE_ACCESS,
        message: messageFor(cause),
      };
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

function visitForTableAccess(
  stmts: Array<{ stmt: Record<string, unknown> }>,
  cfg: TableAccessConfig,
  flagDeny: (cause: DenialCause) => void,
): void {
  const checkRead = (ref: TableRef): void => {
    const resolved = resolvePermission(ref, cfg);
    if (resolved === "deny") {
      flagDeny({ kind: "read_blocked", table: displayName(ref), resolved });
    }
  };
  const checkWrite = (ref: TableRef): void => {
    const resolved = resolvePermission(ref, cfg);
    if (resolved !== "read_write") {
      flagDeny({ kind: "write_blocked", table: displayName(ref), resolved });
    }
  };

  // Stack of CTE-name sets visible at the current walk depth. A bare
  // RangeVar whose relname matches a name in any active scope is a CTE
  // reference (a derived-table alias), not a base-table reference, and
  // must be skipped — otherwise `WITH x AS (SELECT 1) SELECT * FROM x`
  // would incorrectly check the YAML for a table called `x`. Schema-
  // qualified RangeVars (`public.users`) are never CTE references; CTEs
  // can't live in a schema.
  const cteScopes: Set<string>[] = [];
  const isCteReference = (ref: TableRef): boolean => {
    if (ref.schema !== null) return false;
    for (const scope of cteScopes) {
      if (scope.has(ref.relname)) return true;
    }
    return false;
  };

  // Walk the entire tree once, dispatching:
  //   1. On each write-kind statement node, extract write targets and
  //      checkWrite each. Empty target list ⇒ flagDeny with no_target.
  //   2. On each RangeVar (anywhere), checkRead. Targets are double-
  //      counted as reads, but `read_write` satisfies `read` so this
  //      doesn't introduce false positives.
  // CTE names declared by a statement's withClause are pushed before
  // checking targets and walking children, so they shadow bare RangeVars
  // in both positions.
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object") return;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length === 1) {
      const kind = keys[0]!;
      const inner = obj[kind];
      const isTaggedUnion =
        inner !== null &&
        typeof inner === "object" &&
        !Array.isArray(inner) &&
        /^[A-Z]/.test(kind);
      if (isTaggedUnion) {
        const innerObj = inner as Record<string, unknown>;
        if (kind === "RangeVar") {
          const ref = rangeVarToRef(innerObj);
          if (ref && !isCteReference(ref)) checkRead(ref);
          // RangeVar leaves have no nested tables of interest; stop.
          return;
        }
        const cteNames = collectCteNames(innerObj);
        if (cteNames) cteScopes.push(cteNames);
        if (WRITE_STATEMENT_KINDS.has(kind)) {
          const targets = extractWriteTargets(kind, innerObj);
          if (targets.length === 0) {
            flagDeny({ kind: "no_target", statement: humanStatement(kind) });
          } else {
            for (const t of targets) {
              if (!isCteReference(t)) checkWrite(t);
            }
          }
          // Fall through to walk children so nested CTEs / subqueries
          // are still inspected for their own writes/reads.
        }
        for (const k of Object.keys(innerObj)) walk(innerObj[k]);
        if (cteNames) cteScopes.pop();
        return;
      }
    }

    for (const k of keys) walk(obj[k]);
  };

  for (const s of stmts) walk(s.stmt);
}

// Extract the CTE names declared by a statement's withClause, if any.
// Returns null when the statement has no WITH clause; otherwise a Set of
// names visible to the statement and its children.
function collectCteNames(node: Record<string, unknown>): Set<string> | null {
  const wc = node.withClause as Record<string, unknown> | undefined;
  const ctes = wc?.ctes;
  if (!Array.isArray(ctes)) return null;
  const names = new Set<string>();
  for (const entry of ctes) {
    const cte = (entry as Record<string, unknown>)?.CommonTableExpr as
      | Record<string, unknown>
      | undefined;
    const name = cte?.ctename;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names.size > 0 ? names : null;
}

function displayName(ref: TableRef): string {
  return ref.schema !== null ? `${ref.schema}.${ref.relname}` : ref.relname;
}

// Map libpg-query statement kinds to the SQL keyword the user would write
// so the message reads naturally instead of leaking the AST tag. Only
// kinds whose default `Stmt`-stripped form is ugly (GrantRoleStmt →
// "GRANTROLE", AlterDomainStmt → "ALTERDOMAIN") need an explicit entry.
// Single-word stmts (DoStmt, NotifyStmt, DropStmt, GrantStmt, etc.) flow
// through the default branch.
function humanStatement(kind: string): string {
  switch (kind) {
    case "GrantRoleStmt": return "GRANT ROLE";
    case "AlterDomainStmt": return "ALTER DOMAIN";
    case "CreateSchemaStmt": return "CREATE SCHEMA";
    case "CreateRoleStmt": return "CREATE ROLE";
    case "CreatedbStmt": return "CREATE DATABASE";
    case "CreateFunctionStmt": return "CREATE FUNCTION";
    case "VariableSetStmt": return "SET";
    default: return kind.replace(/Stmt$/, "").toUpperCase();
  }
}

function extractWriteTargets(
  kind: string,
  node: Record<string, unknown>,
): TableRef[] {
  // CopyStmt and LockStmt are deliberately omitted — they have side
  // effects beyond row writes (filesystem I/O for COPY, transaction-
  // scoped concurrency holds for LOCK) that the YAML can't reasonably
  // grant per-table. Falling through to default returns [], which
  // promotes the denial to no_target so `webhooks: read_write` doesn't
  // turn into "the agent can COPY webhooks TO '/tmp/leak'".
  switch (kind) {
    case "InsertStmt":
    case "UpdateStmt":
    case "DeleteStmt":
    case "MergeStmt":
    case "AlterTableStmt":
    case "CreateStmt":
    case "IndexStmt":
    case "RuleStmt":
    case "RefreshMatViewStmt":
      return tableRefsFromRelation(node.relation);
    case "TruncateStmt":
      return tableRefsFromList(node.relations);
    case "ViewStmt":
      return tableRefsFromRelation(node.view);
    case "CreateTableAsStmt": {
      const into = node.into as Record<string, unknown> | undefined;
      return tableRefsFromRelation(into?.rel);
    }
    case "DropStmt":
      // .objects is a list of name-lists for OBJECT_TABLE/VIEW/MATVIEW.
      // For non-table removeTypes (DROP ROLE etc.) the per-entry shape
      // doesn't match (entries aren't arrays), so the extractor returns
      // an empty list and the caller denies — no branch needed here.
      return tableRefsFromObjectsList(node.objects);
    case "GrantStmt":
    case "RevokeStmt":
      // .objects is a list of RangeVars for OBJECT_TABLE. Other objtypes
      // (functions, sequences, etc.) put a non-RangeVar shape in
      // .objects, and tableRefsFromList filters them out.
      return tableRefsFromList(node.objects);
    default:
      // AlterDomainStmt, GrantRoleStmt, CreateSchemaStmt, CreateRoleStmt,
      // CreateFunctionStmt, CreatedbStmt, ExecuteStmt, CallStmt, DoStmt,
      // NotifyStmt, ListenStmt, UnlistenStmt — none have an extractable
      // table target. Empty list ⇒ caller denies.
      return [];
  }
}

function tableRefsFromRelation(rel: unknown): TableRef[] {
  if (!rel || typeof rel !== "object" || Array.isArray(rel)) return [];
  const ref = rangeVarToRef(rel as Record<string, unknown>);
  return ref ? [ref] : [];
}

function tableRefsFromList(list: unknown): TableRef[] {
  if (!Array.isArray(list)) return [];
  const out: TableRef[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rangeVar = (item as Record<string, unknown>).RangeVar as
      | Record<string, unknown>
      | undefined;
    if (!rangeVar) continue;
    const ref = rangeVarToRef(rangeVar);
    if (ref) out.push(ref);
  }
  return out;
}

// DropStmt.objects shape for OBJECT_TABLE: list of `{ List: { items: [...] }}`
// wrappers, each `items` a list of `{String: {sval: ...}}` qualifier nodes.
// e.g. `DROP TABLE public.users` → [{List:{items:[String("public"), String("users")]}}].
// For non-table removeTypes the per-entry shape doesn't have `List.items` so
// we return [].
function tableRefsFromObjectsList(objects: unknown): TableRef[] {
  if (!Array.isArray(objects)) return [];
  const out: TableRef[] = [];
  for (const entry of objects) {
    const items = (entry as Record<string, unknown>)?.List as
      | Record<string, unknown>
      | undefined;
    const itemList = items?.items;
    if (!Array.isArray(itemList)) continue;
    const parts: string[] = [];
    for (const part of itemList) {
      const s = (part as Record<string, unknown>)?.String as
        | Record<string, unknown>
        | undefined;
      if (typeof s?.sval === "string") parts.push(s.sval as string);
    }
    if (parts.length === 1) {
      out.push({ schema: null, relname: parts[0]! });
    } else if (parts.length >= 2) {
      // Postgres allows up to db.schema.table; the relevant tail is
      // the last two components.
      out.push({
        schema: parts[parts.length - 2]!,
        relname: parts[parts.length - 1]!,
      });
    }
  }
  return out;
}

function rangeVarToRef(rv: Record<string, unknown>): TableRef | null {
  const relname = rv.relname;
  if (typeof relname !== "string" || relname.length === 0) return null;
  const schemaname = rv.schemaname;
  return {
    schema: typeof schemaname === "string" && schemaname.length > 0 ? schemaname : null,
    relname,
  };
}

function resolvePermission(ref: TableRef, cfg: TableAccessConfig): TableAccessLevel {
  // information_schema is a read-only set of SQL-standard views over schema
  // (not row data), and Postgres itself blocks writes to it. Granting
  // unconditional `read` is structurally required: agents on default-deny
  // tokens need it to discover what tables exist before they can ask the
  // operator for access (the MCP `list_tables` and `describe_table` tools
  // both query information_schema). Placed before the qualified lookup so
  // an explicit `tables: { "information_schema.tables": "deny" }` can't
  // lock discovery out. pg_catalog is intentionally NOT carved out — it
  // exposes pg_roles, pg_proc bodies, pg_settings, etc. which go beyond
  // schema discovery and stay subject to policy.
  if (ref.schema === "information_schema") {
    return "read";
  }
  if (ref.schema !== null) {
    const qualified = `${ref.schema}.${ref.relname}`;
    if (Object.prototype.hasOwnProperty.call(cfg.tables, qualified)) {
      return cfg.tables[qualified]!;
    }
  } else {
    // Bare reference. Postgres's default search_path resolves these to
    // `public.<name>` on 99% of setups, and operators writing per-table
    // policy use the canonical schema-qualified form (`public.users`),
    // not the syntactic form the agent happens to use (`FROM users`).
    // Try `public.<name>` before the bare key so the two match. Without
    // this fallback, default-deny + `public.users: read` denies every
    // unqualified `FROM users` and forces operators to double-list every
    // table under both keys.
    const publicQualified = `public.${ref.relname}`;
    if (Object.prototype.hasOwnProperty.call(cfg.tables, publicQualified)) {
      return cfg.tables[publicQualified]!;
    }
  }
  if (Object.prototype.hasOwnProperty.call(cfg.tables, ref.relname)) {
    return cfg.tables[ref.relname]!;
  }
  return cfg.default;
}
