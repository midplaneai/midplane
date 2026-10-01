// The rewrite stage. Masks are applied at the source: each masked relation a
// statement reads is replaced by a subquery projecting its columns through
// their masks, so every filter, join and aggregate above it sees masked
// values. The AST is edited and deparsed; SQL text is never spliced.

import type { DatabasePolicy, MaskRule, Relation } from "@midplane/protocol";
import type { Node, ResTarget, SelectStmt } from "@pgsql/types";
import { parseSync } from "libpg-query";
import { Deparser } from "pgsql-deparser";
import { clone } from "./ast.ts";
import { CREATION_SCHEMA, relationKey } from "./catalog.ts";
import { Deny } from "./deny.ts";
import { maskExpression } from "./masks.ts";
import { parseOne } from "./parse.ts";
import type { Resolver } from "./resolve.ts";
import type { StatementAnalysis } from "./statement.ts";
import type { Preview } from "./types.ts";

function maskDeny(reason: string): Deny {
  return new Deny("mask", `Midplane denied this query because ${reason}.`);
}

/** The mask entry for a relation: its own, else its top parent's. */
export function masksFor(
  policy: DatabasePolicy,
  relation: Relation,
): Record<string, MaskRule> | null {
  const own = policy.masks[relationKey(relation.schema, relation.name)];
  if (own) return own;
  if (relation.parent) {
    return (
      policy.masks[relationKey(relation.parent.schema, relation.parent.name)] ??
      null
    );
  }
  return null;
}

/** A column's effective rule: unlisted columns of a masked table are redacted. */
export function ruleFor(
  entry: Record<string, MaskRule>,
  column: string,
): MaskRule {
  return entry[column] ?? "full-redact";
}

function columnRef(...parts: string[]): Node {
  return { ColumnRef: { fields: parts.map((p) => ({ String: { sval: p } })) } };
}

/** Every column of `relation` in order, masked ones through their mask. */
function maskedProjection(
  relation: Relation,
  entry: Record<string, MaskRule>,
  columnNode: (column: string) => Node,
): Node[] {
  const key = relationKey(relation.schema, relation.name);
  return relation.columns.map((c) => {
    const rule = ruleFor(entry, c.name);
    const col = columnNode(c.name);
    if (rule === "none") {
      return { ResTarget: { name: c.name, val: col } };
    }
    const masked = maskExpression(rule, col, c);
    if (!masked.ok) {
      throw maskDeny(
        `column ${key}.${c.name} can't be masked as configured (${masked.reason})`,
      );
    }
    return { ResTarget: { name: c.name, val: masked.expr } };
  });
}

export interface RewriteResult {
  changed: boolean;
}

export function rewrite(
  stmt: Node,
  resolver: Resolver,
  analysis: StatementAnalysis,
  policy: DatabasePolicy,
): RewriteResult {
  let changed = false;

  // 1. Wrap every masked relation read directly in FROM.
  for (const use of resolver.uses) {
    if (use.position !== "read" || use.node === null) continue;
    const entry = masksFor(policy, use.relation);
    if (!entry) continue;
    if (use.sampled) {
      throw maskDeny(
        `${use.key} is masked, and masks can't be applied under TABLESAMPLE`,
      );
    }
    const inner: SelectStmt = {
      targetList: maskedProjection(use.relation, entry, (c) => columnRef(c)),
      fromClause: [
        {
          RangeVar: {
            schemaname: use.relation.schema,
            relname: use.relation.name,
            // libpg_query omits false, and the deparser prints ONLY only for
            // an absent `inh`: keep the parser's own shape.
            ...(use.rv.inh === true ? { inh: true } : {}),
            relpersistence: "p",
          },
        },
      ],
      limitOption: "LIMIT_OPTION_DEFAULT",
      op: "SETOP_NONE",
    };
    const node = use.node as Record<string, unknown>;
    delete node.RangeVar;
    node.RangeSubselect = {
      subquery: { SelectStmt: inner },
      alias: use.rv.alias
        ? clone(use.rv.alias)
        : { aliasname: use.relation.name },
    };
    use.rte.wrapped = true;
    changed = true;
  }

  // A wrapped relation is a subquery, so only its alias qualifies its columns.
  for (const b of resolver.bindings) {
    if (b.schemaQualified && b.rte.wrapped) {
      throw maskDeny(
        `a masked table is referenced as schema.table.column; use the table name or an alias`,
      );
    }
  }

  // 2. A masked write target is never wrapped, so guard how its columns are used.
  if (rewriteMaskedTarget(stmt, resolver, policy)) changed = true;

  // 3. Qualify a created table, so the gateway's search path can't redirect it.
  if (analysis.creation && !analysis.creation.rv.schemaname) {
    analysis.creation.rv.schemaname = CREATION_SCHEMA;
    changed = true;
  }

  return { changed };
}

function returningList(stmt: Node): Node[] | null {
  if ("InsertStmt" in stmt)
    return stmt.InsertStmt.returningClause?.exprs ?? null;
  if ("UpdateStmt" in stmt)
    return stmt.UpdateStmt.returningClause?.exprs ?? null;
  if ("DeleteStmt" in stmt)
    return stmt.DeleteStmt.returningClause?.exprs ?? null;
  return null;
}

function hasFromItems(stmt: Node): boolean {
  if ("UpdateStmt" in stmt)
    return (stmt.UpdateStmt.fromClause?.length ?? 0) > 0;
  if ("DeleteStmt" in stmt)
    return (stmt.DeleteStmt.usingClause?.length ?? 0) > 0;
  return false;
}

/**
 * A write to a masked table: its masked columns may appear only as bare
 * RETURNING outputs, which are masked in place. Anywhere else (WHERE, SET,
 * ON CONFLICT, a computed RETURNING) the raw value would leak through the
 * rows-affected count or be copied into a column that reads back unmasked.
 */
function rewriteMaskedTarget(
  stmt: Node,
  resolver: Resolver,
  policy: DatabasePolicy,
): boolean {
  const target = resolver.uses.find(
    (u) => u.position === "write" && u.rte.target,
  );
  if (!target) return false;
  const entry = masksFor(policy, target.relation);
  if (!entry) return false;
  const masked = (column: string) => ruleFor(entry, column) !== "none";
  let changed = false;
  const handled = new Set<object>();

  // ON CONFLICT (col) on a masked column answers whether a raw value exists.
  for (const column of resolver.arbiterColumns) {
    if (masked(column)) {
      throw maskDeny(
        `the write to masked table ${target.key} names masked column ${column} as its ON CONFLICT target`,
      );
    }
  }

  const list = returningList(stmt);
  if (list) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !("ResTarget" in item)) continue;
      const rt: ResTarget = item.ResTarget;
      const val = rt.val;
      if (!val || !("ColumnRef" in val)) continue;
      const fields = val.ColumnRef.fields ?? [];
      const last = fields[fields.length - 1];
      if (!last || !("A_Star" in last)) continue;
      if (fields.length > 1 || hasFromItems(stmt)) {
        throw maskDeny(
          `RETURNING * on masked table ${target.key} can't be masked in this form; list the columns explicitly`,
        );
      }
      const expanded = maskedProjection(target.relation, entry, (c) =>
        columnRef(c),
      );
      list.splice(i, 1, ...expanded);
      i += expanded.length - 1;
      handled.add(val.ColumnRef);
      changed = true;
    }
  }

  for (const b of resolver.bindings) {
    if (!b.rte.target || handled.has(b.ref)) continue;
    if (b.column === null) {
      throw maskDeny(
        `the statement uses the whole row of masked table ${target.key}`,
      );
    }
    if (!masked(b.column)) continue;
    if (!b.bareReturning) {
      throw maskDeny(
        `the write to masked table ${target.key} uses masked column ${b.column} outside a plain RETURNING; masks protect reads, so a write may not filter on, copy, or compute from a masked value`,
      );
    }
    const item = list?.find(
      (n) =>
        "ResTarget" in n &&
        n.ResTarget.val &&
        "ColumnRef" in n.ResTarget.val &&
        n.ResTarget.val.ColumnRef === b.ref,
    );
    if (!item || !("ResTarget" in item)) {
      throw maskDeny(
        `a masked RETURNING column of ${target.key} could not be located`,
      );
    }
    const column = target.relation.columns.find((c) => c.name === b.column);
    const rule = ruleFor(entry, b.column);
    if (!column || rule === "none") continue;
    const out = maskExpression(rule, { ColumnRef: clone(b.ref) }, column);
    if (!out.ok) {
      throw maskDeny(
        `column ${target.key}.${b.column} can't be masked as configured (${out.reason})`,
      );
    }
    item.ResTarget.name ??= b.column;
    item.ResTarget.val = out.expr;
    changed = true;
  }
  return changed;
}

type SelectContext = Parameters<Deparser["SelectStmt"]>[1];

/**
 * pgsql-deparser 18.3.8 carries the UPDATE SET and INSERT column-list context
 * into nested SELECTs, printing their `expr AS name` items as `name = expr`.
 * Inside `UPDATE t SET a = (SELECT ...)` that turns a masking subquery into
 * comparisons and lets the name bind to the target's raw column. Each SELECT
 * starts a fresh select list, so clear those flags on the way in.
 */
class FaithfulDeparser extends Deparser {
  override SelectStmt(node: SelectStmt, context: SelectContext): string {
    const fresh = Object.assign(
      Object.create(Object.getPrototypeOf(context)) as SelectContext,
      context,
      { update: false, insertColumns: false },
    );
    return super.SelectStmt(node, fresh);
  }
}

function deparseRaw(stmt: Node): string {
  return new FaithfulDeparser(stmt, { pretty: false }).deparseQuery();
}

// Fields that record where text sat, or how a call was spelled; neither
// changes what a statement means.
const COSMETIC = new Set([
  "location",
  "stmt_location",
  "stmt_len",
  "rexpr_list_start",
  "rexpr_list_end",
  "list_start",
  "list_end",
  "funcformat",
]);

/** A canonical form for comparing trees: no cosmetic fields, no proto3 defaults, sorted keys. */
function canonical(value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        if (COSMETIC.has(k)) continue;
        const x = (v as Record<string, unknown>)[k];
        if (x === 0 || x === false || x === "" || x === undefined) continue;
        if (Array.isArray(x) && x.length === 0) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(value));
}

/**
 * Deparse a tree, then parse the text back: the text if it is exactly one
 * statement with the same tree, otherwise null.
 */
export function deparseFaithfully(stmt: Node): string | null {
  const sql = deparseRaw(stmt);
  let back: { stmt?: Node }[];
  try {
    back = parseSync(sql).stmts ?? [];
  } catch {
    return null;
  }
  const [only] = back;
  if (back.length !== 1 || !only?.stmt) return null;
  return canonical(only.stmt) === canonical(stmt) ? sql : null;
}

/**
 * A statement as Midplane reads it: parsed, then printed back. Comments,
 * padding and odd line breaks in the text are gone, so they can't hide part
 * of what runs from a person reading it. Null when it isn't one statement
 * the deparser can print faithfully.
 */
export function normalizeStatement(sql: string): string | null {
  try {
    return deparseFaithfully(parseOne(sql));
  } catch {
    return null;
  }
}

/**
 * Deparse a rewritten tree, requiring the text to parse back to the same
 * tree. What the gateway executes must be exactly what was analyzed; if the
 * deparser can't say it faithfully, the statement is denied.
 */
export function deparse(stmt: Node): string {
  const sql = deparseFaithfully(stmt);
  if (sql === null) {
    throw new Deny(
      "unsupported",
      "Midplane denied this query because it could not rewrite it faithfully: the rewritten statement would not mean what was checked.",
    );
  }
  return sql;
}

const countStar = (): Node => ({
  ResTarget: {
    name: "count",
    val: {
      FuncCall: {
        funcname: [
          { String: { sval: "pg_catalog" } },
          { String: { sval: "count" } },
        ],
        agg_star: true,
        funcformat: "COERCE_EXPLICIT_CALL",
      },
    },
  },
});

const select = (s: SelectStmt): Node => ({
  SelectStmt: { limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE", ...s },
});

function countOver(
  query: SelectStmt,
  withClause: SelectStmt["withClause"],
): Node {
  const inner = clone(query);
  // SELECT INTO over a set operation keeps its INTO on the leftmost arm.
  for (let s: SelectStmt | undefined = inner; s; s = s.larg)
    delete s.intoClause;
  return select({
    targetList: [countStar()],
    fromClause: [
      {
        RangeSubselect: {
          subquery: { SelectStmt: inner },
          alias: { aliasname: "rows" },
        },
      },
    ],
    ...(withClause ? { withClause: clone(withClause) } : {}),
  });
}

/**
 * The SELECT that counts what a held write would change, built from the
 * rewritten statement so it sees the same masked sources. Null for writes
 * that aren't counted in rows (schema changes, CREATE TABLE).
 */
export function buildPreview(
  stmt: Node,
  analysis: StatementAnalysis,
  volatile: boolean,
): Preview | null {
  // A volatile call (random(), nextval()) makes a count taken now say
  // nothing about the rows the write will change, and nextval() can't even
  // run in the read-only preview. No count beats a wrong one.
  if (volatile) return null;
  if ("UpdateStmt" in stmt || "DeleteStmt" in stmt) {
    const s = "UpdateStmt" in stmt ? stmt.UpdateStmt : stmt.DeleteStmt;
    const extra =
      "UpdateStmt" in stmt
        ? stmt.UpdateStmt.fromClause
        : stmt.DeleteStmt.usingClause;
    const target = s.relation;
    if (!target || !s.whereClause) return null;
    // With FROM/USING, a target row counts once however many rows it joins.
    const where: Node = extra?.length
      ? {
          SubLink: {
            subLinkType: "EXISTS_SUBLINK",
            subselect: select({
              fromClause: clone(extra),
              whereClause: clone(s.whereClause),
            }),
          },
        }
      : clone(s.whereClause);
    const preview = select({
      targetList: [countStar()],
      fromClause: [{ RangeVar: clone(target) }],
      whereClause: where,
      ...(s.withClause ? { withClause: clone(s.withClause) } : {}),
    });
    return previewOf(preview, true);
  }
  if ("InsertStmt" in stmt) {
    const s = stmt.InsertStmt;
    const oc = s.onConflictClause;
    const exact = !oc || (oc.action === "ONCONFLICT_UPDATE" && !oc.whereClause);
    const source = s.selectStmt;
    if (!source) {
      return previewOf(select({ targetList: [literalCount(1)] }), exact);
    }
    if (!("SelectStmt" in source)) return null;
    const src = source.SelectStmt;
    const values = src.valuesLists;
    // VALUES rows are counted, not evaluated: a read-only preview can't run nextval().
    if (values?.length && !src.limitCount && !src.limitOffset) {
      return previewOf(
        select({ targetList: [literalCount(values.length)] }),
        exact,
      );
    }
    return previewOf(countOver(source.SelectStmt, s.withClause), exact);
  }
  if (analysis.fill) {
    return previewOf(countOver(analysis.fill, undefined), !analysis.maybeEmpty);
  }
  return null;
}

/** A preview that can't be deparsed faithfully is dropped, not guessed. */
function previewOf(node: Node, exact: boolean): Preview | null {
  try {
    return { sql: deparse(node), exact };
  } catch (err) {
    if (err instanceof Deny) return null;
    throw err;
  }
}

function literalCount(n: number): Node {
  return {
    ResTarget: {
      name: "count",
      val: {
        TypeCast: {
          arg: { A_Const: { ival: { ival: n } } },
          typeName: {
            names: [
              { String: { sval: "pg_catalog" } },
              { String: { sval: "int8" } },
            ],
            typemod: -1,
          },
        },
      },
    },
  };
}
