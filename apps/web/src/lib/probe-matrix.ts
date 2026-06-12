// Probe matrix for the policy test panel — the zero-typing path. For
// each table: one probe per action, plus a cross-tenant select for
// tables under tenant scoping (the demo-worthy deny). Built cloud-side
// from the introspected table list ∪ policy entries; evaluated by the
// engine via /admin/dry-run. Nothing here executes anything.
//
// Pure TS, client-importable — types come from the /policy subpath
// only (see CLAUDE.md "Client-component imports from @midplane-cloud/db").
//
// V1 probe set is pinned in the design doc: select / insert / update /
// delete per table + cross-tenant select per scoped table. Extensions
// are additive.

import type {
  AccessLevel,
  GuardrailsConfig,
  TableAccessPolicy,
  TenantScopeConfig,
} from "@midplane-cloud/db/policy";

/** Synthetic tenant bound by the engine during dry-run. Nothing
 *  executes, so no real tenant value is ever needed. */
export const PROBE_TENANT_VALUE = "__midplane_probe__";

/** Mirror of the engine-side cap (50 tables → ≤250 probes per run).
 *  The UI truncates BEFORE the request so the "showing first N" line
 *  is accurate even against an engine that doesn't enforce it. */
export const PROBE_TABLE_CAP = 50;

export const PROBE_ACTIONS = ["select", "insert", "update", "delete"] as const;
export type ProbeAction = (typeof PROBE_ACTIONS)[number];

/** Worst case: every capped table is tenant-scoped (4 actions + 1
 *  cross-tenant select). The dry-run route's request validator uses
 *  this so a cap or action change can't silently 400 the panel's own
 *  requests. */
export const MAX_PROBES_PER_RUN = PROBE_TABLE_CAP * (PROBE_ACTIONS.length + 1);

export interface Probe {
  table: string;
  action: ProbeAction;
  cross_tenant?: boolean;
}

/** True when tenant scoping would bind a predicate on this table:
 *  a default column or a per-table override, and not exempted. */
export function isTenantScoped(
  table: string,
  scope: TenantScopeConfig,
): boolean {
  if (scope.exempt.includes(table)) return false;
  if (scope.overrides[table] !== undefined) return true;
  return scope.column !== null;
}

export interface ProbeMatrix {
  probes: Probe[];
  /** Tables included after the cap. */
  tables: string[];
  /** Total candidate tables before the cap. */
  totalTables: number;
  truncated: boolean;
}

/** Dedupe (introspection ∪ policy entries can overlap), cap, expand.
 *  Input order is preserved — callers pass introspected-then-policy so
 *  real tables sort ahead of policy-only entries. */
export function buildProbeMatrix(
  tables: readonly string[],
  tenantScope: TenantScopeConfig,
): ProbeMatrix {
  const unique = [...new Set(tables.filter((t) => t.length > 0))];
  const included = unique.slice(0, PROBE_TABLE_CAP);

  const probes: Probe[] = [];
  for (const table of included) {
    for (const action of PROBE_ACTIONS) {
      probes.push({ table, action });
    }
    if (isTenantScoped(table, tenantScope)) {
      probes.push({ table, action: "select", cross_tenant: true });
    }
  }
  return {
    probes,
    tables: included,
    totalTables: unique.length,
    truncated: unique.length > included.length,
  };
}

/** The level governing a table: an explicit override, else the default. */
export function effectiveLevel(
  table: string,
  policy: TableAccessPolicy,
): AccessLevel {
  return policy.tables[table] ?? policy.default;
}

/** What the policy-as-configured *should* decide for a probe — the naive
 *  cloud-side model the engine's live verdict is reconciled against. A
 *  disagreement means the engine isn't enforcing what the editor shows:
 *  a policy that never reached the engine, a parse surprise, or scoping
 *  that didn't bind. select is allowed at read+; writes only at
 *  read_write; a cross-tenant read is denied wherever scoping binds
 *  (the predicate keeps one tenant from reading another's rows). */
export function expectedDecision(
  probe: Probe,
  policy: TableAccessPolicy,
  scope: TenantScopeConfig,
): "allow" | "deny" {
  const level = effectiveLevel(probe.table, policy);
  if (probe.cross_tenant) {
    // Only emitted for scoped tables; denied unless the base select was
    // already denied by level — either way the answer is deny.
    return "deny";
  }
  if (probe.action === "select") {
    return level === "deny" ? "deny" : "allow";
  }
  // insert / update / delete
  return level === "read_write" ? "allow" : "deny";
}

// --- guardrail probes --------------------------------------------------------
//
// The engine's probe schema is a closed (table, action) vocabulary, and
// 0.9.0 deliberately WHERE-qualifies every DML probe so the matrix tests
// table_access, not guardrails. Guardrail checks therefore travel as
// literal dangerous statements through the dry-run `sql` path — one
// statement per engine call, batched into the same cloud request as the
// probe matrix (one rate-limit unit, one engine acquire).
//
// Guardrails are per-DB, not per-table, so ONE representative table is
// enough — callers pass the first table of the built matrix. Probes are
// only emitted for flags that are ON: expected verdict is always deny,
// and the engine's actual answer reconciles against that. An OFF flag
// has no cloud-side expectation worth asserting (the statement falls
// through to table_access, whose DDL semantics the panel doesn't model).

export type GuardrailProbeKind =
  | "unqualified_delete"
  | "unqualified_update"
  | "ddl_drop"
  | "ddl_truncate"
  | "ddl_alter";

export interface GuardrailProbe {
  /** Single dangerous statement for the dry-run `sql` path. Never executed. */
  sql: string;
  /** Row label — mono, SQL keywords UPPERCASE against lowercase
   *  identifiers + prose (DESIGN.md voice-split carve-out). */
  label: string;
  kind: GuardrailProbeKind;
}

/** Ceiling for the dry-run route's request validator: both flags on
 *  emits 2 DML + 3 DDL statements. */
export const MAX_GUARDRAIL_PROBES = 5;

/** Throwaway column for the unqualified-update SET clause — only parsed,
 *  never resolved against the real schema. */
const GUARDRAIL_PROBE_COLUMN = "midplane_probe";

/** Double-quote each part of a (possibly schema-qualified) identifier so
 *  the generated statement parses even when the table name is a reserved
 *  word — `delete from user` fails the engine's parser, and the dry-run
 *  custom-sql path turns a parse failure into a 400 that kills the WHOLE
 *  panel run (unlike structured matrix probes, which degrade to a
 *  parse_error verdict row). Introspection returns actual catalog names,
 *  so quoting preserves resolution; labels keep the bare name. */
function quoteIdent(table: string): string {
  return table
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}

/** Representative table for the guardrail probes. Prefer one whose
 *  effective level is read_write: there table_access permits the write,
 *  so the guardrail is the ONLY thing standing between the statement and
 *  the data — a deny proves the net. On a deny/read table the statement
 *  is denied by table_access before the guardrail is consulted, which
 *  verifies nothing about it (the panel labels those honestly, but a
 *  default-deny policy would otherwise never exercise the guardrail). */
export function pickGuardrailTable(
  tables: readonly string[],
  policy: TableAccessPolicy,
): string | undefined {
  return (
    tables.find((t) => effectiveLevel(t, policy) === "read_write") ?? tables[0]
  );
}

export function buildGuardrailProbes(
  table: string | undefined,
  guardrails: GuardrailsConfig,
): GuardrailProbe[] {
  if (!table) return [];
  const ident = quoteIdent(table);
  const probes: GuardrailProbe[] = [];
  // Labels put SQL keywords in UPPERCASE against lowercase identifiers +
  // prose: all-lowercase made "with no where" read as English, and the
  // caps also set these statement rows apart from the matrix's lowercase
  // action labels ("delete from orders" — which IS where-qualified under
  // the hood). The sql sent to the engine stays lowercase like every
  // other generated statement; the parser doesn't care.
  if (guardrails.block_unqualified_dml) {
    probes.push(
      {
        sql: `delete from ${ident}`,
        label: `DELETE FROM ${table} with no WHERE`,
        kind: "unqualified_delete",
      },
      {
        sql: `update ${ident} set ${GUARDRAIL_PROBE_COLUMN} = null`,
        label: `UPDATE ${table} with no WHERE`,
        kind: "unqualified_update",
      },
    );
  }
  if (guardrails.block_ddl) {
    probes.push(
      {
        sql: `drop table ${ident}`,
        label: `DROP TABLE ${table}`,
        kind: "ddl_drop",
      },
      {
        sql: `truncate ${ident}`,
        label: `TRUNCATE ${table}`,
        kind: "ddl_truncate",
      },
      {
        sql: `alter table ${ident} add column ${GUARDRAIL_PROBE_COLUMN} int`,
        label: `ALTER TABLE ${table}`,
        kind: "ddl_alter",
      },
    );
  }
  return probes;
}

// --- guardrail reconciliation ------------------------------------------------
//
// Pure so it gets unit coverage — four review specialists independently
// flagged the original inline positional zip for failing OPEN: a verdict
// the engine never returned would silently vanish from both the mismatch
// and the holds list, letting the headline read "✓ engine enforces your
// policy" over an unverified guardrail. Here a missing verdict is a
// failure (`verdict: null`, `match: false`), never an omission.

/** The slice of an engine dry-run verdict the reconciliation needs. */
export interface GuardrailVerdictLike {
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
}

export interface ReconciledGuardrail {
  probe: GuardrailProbe;
  /** null = the engine returned no verdict for this probe. Rendered as a
   *  failed check, never dropped. */
  verdict: GuardrailVerdictLike | null;
  /** The net held: the statement came back denied (by any rule). */
  match: boolean;
  /** Denied specifically by the dangerous_statement rule. False when an
   *  earlier rule (e.g. table_access deny) caught the statement first —
   *  still a deny, but the row must not claim the guardrail did it. */
  byGuardrail: boolean;
}

/** Zip probes to verdicts by position (the engine answers the sequence in
 *  request order). Length mismatches reconcile to failed checks. */
export function reconcileGuardrails(
  probes: readonly GuardrailProbe[],
  verdicts: readonly GuardrailVerdictLike[],
): ReconciledGuardrail[] {
  return probes.map((probe, i) => {
    const verdict = verdicts[i] ?? null;
    return {
      probe,
      verdict,
      match: verdict?.decision === "deny",
      byGuardrail: verdict?.matched_rule === "dangerous_statement",
    };
  });
}

/** Human label for a probe row — mono, lowercase, reads like the SQL
 *  it stands for. */
export function probeLabel(probe: Probe): string {
  if (probe.cross_tenant) return `select another tenant's rows from ${probe.table}`;
  switch (probe.action) {
    case "select":
      return `select from ${probe.table}`;
    case "insert":
      return `insert into ${probe.table}`;
    case "update":
      return `update ${probe.table}`;
    case "delete":
      return `delete from ${probe.table}`;
  }
}
