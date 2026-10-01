// What an agent may see of a database's shape: the relations it can read,
// with each column's type and whether it comes back masked. Names and types
// only; this is what list_tables and describe_table serve. Also what the
// cloud shows about masks: the rule each base column gets, and which columns
// no one has reviewed.

import type {
  CatalogSnapshot,
  DatabasePolicy,
  MaskRule,
  Relation,
} from "@midplane/protocol";
import { CatalogIndex, relationKey } from "./catalog.ts";
import { accessLevel } from "./decide.ts";
import type { BaseColumn } from "./resolve.ts";
import { masksFor, ruleFor } from "./rewrite.ts";

export interface VisibleRelation {
  schema: string;
  name: string;
  kind: Relation["kind"];
  access: "read" | "read_write";
  columns: { name: string; type: string; masked: boolean }[];
}

const SYSTEM = new Set(["pg_catalog", "information_schema"]);

export function visibleRelations(
  policy: DatabasePolicy,
  catalog: CatalogSnapshot,
): VisibleRelation[] {
  const out: VisibleRelation[] = [];
  for (const r of catalog.relations) {
    if (SYSTEM.has(r.schema)) continue;
    const access = accessLevel(policy, r.schema, r.name, r.parent);
    if (access === "deny") continue;
    const entry = masksFor(policy, r);
    out.push({
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      access,
      columns: r.columns.map((c) => ({
        name: c.name,
        type: c.type,
        masked: entry !== null && ruleFor(entry, c.name) !== "none",
      })),
    });
  }
  return out;
}

export interface ColumnMask {
  rule: MaskRule;
  /** No rule of its own in a masked table: fully redacted until reviewed. */
  unreviewed: boolean;
}

/**
 * The mask each base column gets under a policy, or null when its table (or
 * the parent it inherits from) has no mask entry.
 */
export function maskLookup(
  policy: DatabasePolicy,
  catalog: CatalogSnapshot,
): (column: BaseColumn) => ColumnMask | null {
  const index = new CatalogIndex(catalog);
  return (c) => {
    const r = index.get(c.schema, c.table);
    const entry = r ? masksFor(policy, r) : null;
    if (!entry) return null;
    const own = entry[c.column];
    return { rule: ruleFor(entry, c.column), unreviewed: own === undefined };
  };
}

const MASKABLE = new Set(["table", "partitioned_table", "foreign_table"]);

/**
 * Columns of tables with a mask entry of their own that have no rule: new
 * since someone last reviewed the table, and fully redacted until then.
 */
export function unreviewedColumns(
  policy: DatabasePolicy,
  catalog: CatalogSnapshot,
): { table: string; column: string; type: string }[] {
  const out: { table: string; column: string; type: string }[] = [];
  for (const r of catalog.relations) {
    if (SYSTEM.has(r.schema) || !MASKABLE.has(r.kind)) continue;
    const table = relationKey(r.schema, r.name);
    const entry = policy.masks[table];
    if (!entry) continue;
    for (const c of r.columns) {
      if (entry[c.name] === undefined) {
        out.push({ table, column: c.name, type: c.type });
      }
    }
  }
  return out;
}
