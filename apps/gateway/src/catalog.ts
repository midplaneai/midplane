// Catalog introspection: names, types, keys and comments, never a value.
// Runs in the same pinned search path as execution, so view definitions
// print names the way the core will resolve them.

import {
  CATALOG_COMMENT_MAX_CHARS,
  type CatalogSnapshot,
  type ForeignKey,
  type Relation,
  type Routine,
} from "@midplane/protocol";
import type pg from "pg";

/**
 * Controls, line breaks, and invisible or direction-changing characters.
 * Not the joiners U+200C and U+200D: Persian and emoji sequences need them.
 */
const UNSEEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff\s]+/g;

/** A COMMENT ON as one line, cut to the cap; undefined when it says nothing. */
export function oneLineComment(text: string | null): string | undefined {
  if (text === null) return undefined;
  const line = text.replace(UNSEEN, " ").trim();
  if (line === "") return undefined;
  // By code point, so the cut never splits a surrogate pair.
  const chars = Array.from(line);
  return chars.length > CATALOG_COMMENT_MAX_CHARS
    ? `${chars.slice(0, CATALOG_COMMENT_MAX_CHARS - 1).join("")}…`
    : line;
}

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
    comment: string | null;
  }>(`
    SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
           CASE WHEN c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                THEN pg_get_viewdef(c.oid, true) END AS definition,
           CASE WHEN n.nspname NOT IN ('pg_catalog', 'information_schema')
                THEN obj_description(c.oid, 'pg_class') END AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname`);

  const cols = await client.query<{
    oid: string;
    attnum: number;
    name: string;
    type: string;
    category: string;
    not_null: boolean;
    comment: string | null;
  }>(`
    SELECT a.attrelid::text AS oid, a.attnum, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type, t.typcategory::text AS category,
           a.attnotnull AS not_null,
           CASE WHEN n.nspname NOT IN ('pg_catalog', 'information_schema')
                THEN col_description(a.attrelid, a.attnum) END AS comment
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`);

  // Primary and foreign keys outside the system schemas, by column number;
  // the catalog never holds a value, and a key says only how tables join.
  const keys = await client.query<{
    oid: string;
    kind: string;
    columns: number[];
    target: string;
    target_columns: number[] | null;
  }>(`
    SELECT k.conrelid::text AS oid, k.contype::text AS kind, k.conkey AS columns,
           k.confrelid::text AS target, k.confkey AS target_columns
      FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
     WHERE k.contype IN ('p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY k.conrelid, k.conname`);

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

  const byOid = new Map(rels.rows.map((r) => [r.oid, r]));
  const columns = new Map<string, Relation["columns"]>();
  const attnames = new Map<string, Map<number, string>>();
  for (const c of cols.rows) {
    const list = columns.get(c.oid) ?? [];
    const comment = oneLineComment(c.comment);
    list.push({
      name: c.name,
      type: c.type,
      category: c.category,
      ...(c.not_null ? { not_null: true } : {}),
      ...(comment ? { comment } : {}),
    });
    columns.set(c.oid, list);
    const names = attnames.get(c.oid) ?? new Map<number, string>();
    names.set(c.attnum, c.name);
    attnames.set(c.oid, names);
  }
  const foreignKeys = new Map<string, ForeignKey[]>();
  for (const k of keys.rows) {
    const names = attnames.get(k.oid);
    const own = k.columns.map((n) => names?.get(n));
    if (own.some((n) => n === undefined)) continue;
    if (k.kind === "p") {
      for (const c of columns.get(k.oid) ?? []) {
        if (own.includes(c.name)) c.primary_key = true;
      }
      continue;
    }
    const target = byOid.get(k.target);
    const targetNames = attnames.get(k.target);
    const theirs = (k.target_columns ?? []).map((n) => targetNames?.get(n));
    if (!target || theirs.length === 0 || theirs.some((n) => n === undefined))
      continue;
    const list = foreignKeys.get(k.oid) ?? [];
    list.push({
      columns: own as string[],
      references: {
        schema: target.schema,
        name: target.name,
        columns: theirs as string[],
      },
    });
    foreignKeys.set(k.oid, list);
  }
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
    const comment = oneLineComment(r.comment);
    const fks = foreignKeys.get(r.oid);
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
      ...(comment ? { comment } : {}),
      ...(fks ? { foreign_keys: fks } : {}),
    });
  }
  return { relations, routines: routines.rows };
}
