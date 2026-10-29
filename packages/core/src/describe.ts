// What an agent may see of a database's shape: the relations it can read,
// with each column's type, keys and comment, and whether it comes back
// masked. Catalog metadata only, never a value; this is what list_tables and
// describe_table serve. Also what the cloud shows about masks: the rule each
// base column gets, and which columns no one has reviewed.

import type {
  CatalogSnapshot,
  DatabasePolicy,
  ForeignKey,
  MaskRule,
  Relation,
} from "@midplane/protocol";
import { CatalogIndex, relationKey } from "./catalog.ts";
import { accessLevel } from "./decide.ts";
import type { BaseColumn } from "./resolve.ts";
import { masksFor, ruleFor } from "./rewrite.ts";

export interface VisibleColumn {
  name: string;
  type: string;
  masked: boolean;
  notNull: boolean;
  primaryKey: boolean;
  comment: string | null;
}

export interface VisibleRelation {
  schema: string;
  name: string;
  kind: Relation["kind"];
  access: "read" | "read_write";
  comment: string | null;
  columns: VisibleColumn[];
  /** Only those whose target the agent may read: a hidden table stays hidden. */
  foreignKeys: ForeignKey[];
}

const SYSTEM = new Set(["pg_catalog", "information_schema"]);

export function visibleRelations(
  policy: DatabasePolicy,
  catalog: CatalogSnapshot,
): VisibleRelation[] {
  // Readable relations first, so a foreign key to one the agent can't read
  // is left out, as list_tables leaves that table out.
  const readable = new Map<string, "read" | "read_write">();
  for (const r of catalog.relations) {
    if (SYSTEM.has(r.schema)) continue;
    const access = accessLevel(policy, r.schema, r.name, r.parent);
    if (access !== "deny") readable.set(relationKey(r.schema, r.name), access);
  }
  const out: VisibleRelation[] = [];
  for (const r of catalog.relations) {
    const access = readable.get(relationKey(r.schema, r.name));
    if (!access) continue;
    const entry = masksFor(policy, r);
    out.push({
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      access,
      comment: r.comment ?? null,
      columns: r.columns.map((c) => ({
        name: c.name,
        type: c.type,
        masked: entry !== null && ruleFor(entry, c.name) !== "none",
        notNull: c.not_null === true,
        primaryKey: c.primary_key === true,
        comment: c.comment ?? null,
      })),
      foreignKeys: (r.foreign_keys ?? []).filter((fk) =>
        readable.has(relationKey(fk.references.schema, fk.references.name)),
      ),
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
