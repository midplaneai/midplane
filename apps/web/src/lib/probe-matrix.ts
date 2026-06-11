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
