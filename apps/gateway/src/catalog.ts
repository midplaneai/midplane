// Catalog introspection: names and types only, never a value. Runs in the
// same pinned search path as execution, so view definitions print names the
// way the core will resolve them.

import type { CatalogSnapshot, Relation, Routine } from "@midplane/protocol";
import type pg from "pg";

const KINDS: Record<string, Relation["kind"]> = {
  r: "table",
  p: "partitioned_table",
  v: "view",
  m: "materialized_view",
  f: "foreign_table",
};

const SYSTEM = new Set(["pg_catalog", "information_schema"]);

export async function introspect(
  client: pg.ClientBase,
): Promise<CatalogSnapshot> {
  const rels = await client.query<{
    oid: string;
    schema: string;
    name: string;
    relkind: string;
    definition: string | null;
  }>(`
    SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
           CASE WHEN c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                THEN pg_get_viewdef(c.oid, true) END AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname`);

  const cols = await client.query<{
    oid: string;
    name: string;
    type: string;
    category: string;
  }>(`
    SELECT a.attrelid::text AS oid, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type, t.typcategory::text AS category
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`);

  const inherits = await client.query<{ child: string; parent: string }>(
    "SELECT inhrelid::text AS child, inhparent::text AS parent FROM pg_inherits",
  );

  const routines = await client.query<{
    schema: string;
    name: string;
    kind: Routine["kind"];
  }>(`
    SELECT n.nspname AS schema, p.proname AS name, 'function' AS kind
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    UNION
    SELECT n.nspname, o.oprname, 'operator'
      FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    UNION
    SELECT n.nspname, t.typname, 'type'
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
     ORDER BY 1, 2, 3`);

  const columns = new Map<string, Relation["columns"]>();
  for (const c of cols.rows) {
    const list = columns.get(c.oid) ?? [];
    list.push({ name: c.name, type: c.type, category: c.category });
    columns.set(c.oid, list);
  }
  const byOid = new Map(rels.rows.map((r) => [r.oid, r]));
  const parentOf = new Map(inherits.rows.map((r) => [r.child, r.parent]));
  const topAncestor = (oid: string): string => {
    let cur = oid;
    const seen = new Set([cur]);
    for (let p = parentOf.get(cur); p && !seen.has(p); p = parentOf.get(cur)) {
      seen.add(p);
      cur = p;
    }
    return cur;
  };

  const relations: Relation[] = [];
  for (const r of rels.rows) {
    const kind = KINDS[r.relkind];
    if (!kind) continue;
    const top = topAncestor(r.oid);
    const parent = top !== r.oid ? byOid.get(top) : undefined;
    relations.push({
      schema: r.schema,
      name: r.name,
      kind,
      columns: columns.get(r.oid) ?? [],
      ...(r.definition && !SYSTEM.has(r.schema)
        ? { definition: r.definition.trim().replace(/;$/, "") }
        : {}),
      ...(parent
        ? { parent: { schema: parent.schema, name: parent.name } }
        : {}),
    });
  }
  return { relations, routines: routines.rows };
}
