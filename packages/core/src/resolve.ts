// The resolve stage: bind every name in a statement the way Postgres does,
// and trace every output field back to the base columns its value comes from.
//
// It mirrors the parser's namespace rules closely enough that a name either
// binds where Postgres would bind it, or doesn't bind at all and the statement
// is denied: FROM items in order, join inputs hidden behind the join for
// unqualified names, LATERAL and function items seeing earlier items, CTEs
// visible lexically (a plain CTE never sees itself), and outer query levels
// searched after the current one. Anything it has no rule for is denied.
//
// Along the way it records what later stages need: every relation reference
// (checked against table access as it binds, then wrapped by the rewrite if
// masked), every column binding, and every function and operator call.

import type { Relation } from "@midplane/protocol";
import type {
  A_Expr,
  Alias,
  ColumnRef,
  CommonTableExpr,
  DeleteStmt,
  FuncCall,
  InsertStmt,
  JoinExpr,
  Node,
  RangeFunction,
  RangeSubselect,
  RangeVar,
  ResTarget,
  ReturningClause,
  SelectStmt,
  SortBy,
  UpdateStmt,
  WithClause,
} from "@pgsql/types";
import {
  kindOf,
  type QualName,
  qualNameOf,
  stringOf,
  stringsOf,
} from "./ast.ts";
import { type CatalogIndex, relationKey } from "./catalog.ts";
import { Deny, unsupported } from "./deny.ts";

/** A base column a value comes from. */
export interface BaseColumn {
  schema: string;
  table: string;
  column: string;
}

export type Lineage = readonly BaseColumn[];

export function unionLineage(...parts: Lineage[]): Lineage {
  const seen = new Set<string>();
  const out: BaseColumn[] = [];
  for (const part of parts) {
    for (const c of part) {
      const key = `${c.schema}\u0000${c.table}\u0000${c.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** One output field of a query. */
export interface OutputColumn {
  name: string;
  lineage: Lineage;
}

interface RteColumn {
  name: string;
  lineage: Lineage;
}

/** A range table entry: something a FROM item or write target makes visible. */
export interface Rte {
  kind:
    | "relation"
    | "view"
    | "cte"
    | "subquery"
    | "function"
    | "join"
    | "excluded";
  /** The name that qualifies its columns; null when it has none. */
  refname: string | null;
  columns: RteColumn[];
  relation?: Relation;
  /** A relation named without an alias, so `schema.table.col` can reach it. */
  unaliased?: boolean;
  /** The statement's write target. */
  target?: boolean;
  /** Set by the rewrite when the relation is wrapped in a masking subquery. */
  wrapped?: boolean;
  /** A function whose output columns aren't known, so `*` can't expand it. */
  opaque?: boolean;
}

interface NsItem {
  rte: Rte;
  relVisible: boolean;
  colsVisible: boolean;
}

interface CteDef {
  columns: RteColumn[] | "pending";
}

interface Scope {
  items: NsItem[];
  /** The next query level out, for column references. */
  parent: Scope | null;
  ctes: Map<string, CteDef>;
  /** The lexically enclosing scope, for CTE names. */
  cteParent: Scope | null;
}

interface Env {
  parent: Scope | null;
  cteParent: Scope | null;
}

/** A reference to a catalog relation made directly by the statement. */
export interface RelationUse {
  /** The FROM-item node to replace when wrapping; null for write targets. */
  node: Node | null;
  rv: RangeVar;
  relation: Relation;
  key: string;
  position: "read" | "write";
  rte: Rte;
  /** Referenced under TABLESAMPLE, which a masking wrap can't preserve. */
  sampled?: boolean;
}

/** A column reference and what it bound to. */
export interface ColumnBinding {
  ref: ColumnRef;
  rte: Rte;
  /** null for a whole-row reference (`t`, `t.*`). */
  column: string | null;
  /** Written as `schema.table.column`. */
  schemaQualified: boolean;
  /** A bare column that is itself a RETURNING output. */
  bareReturning: boolean;
}

export interface Hooks {
  /** Called as each relation reference binds; may throw a Deny. */
  onRelation(use: RelationUse): void;
}

const MAX_VIEW_DEPTH = 16;

// Set-returning functions known to return exactly one column. Any other
// function in FROM may return several, so `*` over it can't be expanded.
const SINGLE_COLUMN_SRFS = new Set([
  "generate_series",
  "generate_subscripts",
  "regexp_split_to_table",
  "string_to_table",
  "json_array_elements",
  "jsonb_array_elements",
  "json_array_elements_text",
  "jsonb_array_elements_text",
  "json_object_keys",
  "jsonb_object_keys",
]);

function unresolved(reason: string): Deny {
  return new Deny(
    "unresolved",
    `Midplane denied this query because ${reason}. Every name in a statement must resolve against the database's catalog before it runs.`,
  );
}

function names(nodes: Node[] | undefined): string[] {
  const out = stringsOf(nodes);
  if (out === null) throw unsupported("a non-identifier in a name list");
  return out;
}

function applyAlias(
  columns: RteColumn[],
  alias: Alias | undefined,
): RteColumn[] {
  const colnames = alias?.colnames ? names(alias.colnames) : [];
  if (colnames.length > columns.length) {
    throw unresolved(
      `the alias "${alias?.aliasname ?? ""}" names more columns than its source has`,
    );
  }
  return columns.map((c, i) => ({
    name: colnames[i] ?? c.name,
    lineage: c.lineage,
  }));
}

/** The name Postgres gives an unnamed output column (FigureColname). */
export function figureColname(node: Node | undefined): string {
  return figure(node)?.name ?? "?column?";
}

function figure(
  node: Node | undefined,
): { name: string; strength: number } | null {
  if (!node) return null;
  if ("ColumnRef" in node) {
    const fields = node.ColumnRef.fields ?? [];
    const last = stringOf(fields[fields.length - 1]);
    return last !== null ? { name: last, strength: 2 } : null;
  }
  if ("A_Indirection" in node) {
    const ind = node.A_Indirection.indirection ?? [];
    for (let i = ind.length - 1; i >= 0; i--) {
      const s = stringOf(ind[i]);
      if (s !== null) return { name: s, strength: 2 };
    }
    return figure(node.A_Indirection.arg);
  }
  if ("FuncCall" in node) {
    const q = qualNameOf(node.FuncCall.funcname);
    return q ? { name: q.name, strength: 2 } : null;
  }
  if ("A_Expr" in node) {
    if (node.A_Expr.kind === "AEXPR_NULLIF")
      return { name: "nullif", strength: 2 };
    return null;
  }
  if ("TypeCast" in node) {
    const inner = figure(node.TypeCast.arg);
    if (inner && inner.strength > 1) return inner;
    const t = qualNameOf(node.TypeCast.typeName?.names);
    return t ? { name: t.name, strength: 1 } : inner;
  }
  if ("CollateClause" in node) return figure(node.CollateClause.arg);
  if ("CaseExpr" in node) {
    const inner = figure(node.CaseExpr.defresult);
    return inner && inner.strength > 1 ? inner : { name: "case", strength: 1 };
  }
  if ("A_ArrayExpr" in node) return { name: "array", strength: 2 };
  if ("RowExpr" in node) return { name: "row", strength: 2 };
  if ("CoalesceExpr" in node) return { name: "coalesce", strength: 2 };
  if ("MinMaxExpr" in node) {
    const op = node.MinMaxExpr.op === "IS_LEAST" ? "least" : "greatest";
    return { name: op, strength: 2 };
  }
  if ("GroupingFunc" in node) return { name: "grouping", strength: 2 };
  if ("SQLValueFunction" in node) {
    const op = node.SQLValueFunction.op ?? "";
    const name = op
      .replace(/^SVFOP_/, "")
      .replace(/_N$/, "")
      .toLowerCase();
    return { name, strength: 2 };
  }
  if ("SubLink" in node) {
    const t = node.SubLink.subLinkType;
    if (t === "EXISTS_SUBLINK") return { name: "exists", strength: 2 };
    if (t === "ARRAY_SUBLINK") return { name: "array", strength: 2 };
    if (t === "EXPR_SUBLINK") {
      const sub = node.SubLink.subselect;
      if (sub && "SelectStmt" in sub) {
        const first = sub.SelectStmt.targetList?.[0];
        if (first && "ResTarget" in first) {
          if (first.ResTarget.name) {
            return { name: first.ResTarget.name, strength: 2 };
          }
          return figure(first.ResTarget.val);
        }
      }
    }
    return null;
  }
  return null;
}

/** Recognizes a SELECT that references a CTE name anywhere within it. */
function mentionsRelation(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((n) => mentionsRelation(n, name));
  if (!node || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  const rv = o.RangeVar as RangeVar | undefined;
  if (rv && !rv.schemaname && rv.relname === name) return true;
  return Object.values(o).some((v) => mentionsRelation(v, name));
}

export class Resolver {
  readonly uses: RelationUse[] = [];
  /** Relations reached only through a view's definition. */
  readonly viewUses: { key: string; relation: Relation; view: string }[] = [];
  readonly bindings: ColumnBinding[] = [];
  readonly functions: QualName[] = [];
  readonly operators: QualName[] = [];
  /** Calls inside view definitions: not the agent's, but they run. */
  readonly viewFunctions: QualName[] = [];
  /** Type names cast to, in the statement and in its views. */
  readonly types: QualName[] = [];
  /** Write-target columns named as an ON CONFLICT arbiter. */
  readonly arbiterColumns: string[] = [];
  /** Base columns whose values a write stores (INSERT source, SET values). */
  readonly written: BaseColumn[] = [];
  /** Every node object the analysis handled, for the coverage sweep. */
  readonly visited = new WeakSet<object>();

  private readonly viewStack: string[] = [];
  /** > 0 while re-analyzing a recursive CTE for its lineage fixpoint. */
  private silent = 0;

  private readonly catalog: CatalogIndex;
  private readonly hooks: Hooks;

  constructor(catalog: CatalogIndex, hooks: Hooks) {
    this.catalog = catalog;
    this.hooks = hooks;
  }

  private get recording(): boolean {
    return this.silent === 0 && this.viewStack.length === 0;
  }

  // ── scopes ────────────────────────────────────────────────────────────────

  private newScope(env: Env): Scope {
    return {
      items: [],
      parent: env.parent,
      ctes: new Map(),
      cteParent: env.cteParent,
    };
  }

  private lookupCte(scope: Scope | null, name: string): CteDef | null {
    for (let s = scope; s; s = s.cteParent) {
      const cte = s.ctes.get(name);
      if (cte) return cte;
    }
    return null;
  }

  // ── statements ────────────────────────────────────────────────────────────

  /** Analyze a SELECT (including VALUES and set operations). */
  select(stmt: SelectStmt, env: Env): OutputColumn[] {
    this.visited.add(stmt);
    if (stmt.lockingClause?.length) {
      throw unsupported("a locking clause (FOR UPDATE, FOR SHARE)");
    }
    const scope = this.newScope(env);
    if (stmt.withClause) this.withClause(stmt.withClause, scope);

    if (stmt.op && stmt.op !== "SETOP_NONE") {
      if (!stmt.larg || !stmt.rarg)
        throw unsupported("an incomplete set operation");
      const armEnv: Env = { parent: env.parent, cteParent: scope };
      const left = this.select(stmt.larg, armEnv);
      const right = this.select(stmt.rarg, armEnv);
      if (left.length !== right.length) {
        throw unresolved(
          "the queries in a UNION, INTERSECT or EXCEPT return different numbers of columns",
        );
      }
      const out = left.map((c, i) => ({
        name: c.name,
        lineage: unionLineage(c.lineage, right[i]?.lineage ?? []),
      }));
      this.outputOnlySort(stmt.sortClause, out);
      this.limits(stmt, scope);
      return out;
    }

    if (stmt.valuesLists) {
      const out = this.values(stmt.valuesLists, scope);
      this.outputOnlySort(stmt.sortClause, out);
      this.limits(stmt, scope);
      return out;
    }

    for (const item of stmt.fromClause ?? []) {
      scope.items.push(...this.fromItem(item, scope, scope.items));
    }
    if (stmt.whereClause) this.expr(stmt.whereClause, scope);
    const out = this.targetList(stmt.targetList ?? [], scope, false);

    for (const g of stmt.groupClause ?? []) this.groupItem(g, scope, out);
    if (stmt.havingClause) this.expr(stmt.havingClause, scope);
    for (const w of stmt.windowClause ?? []) {
      if (!("WindowDef" in w)) throw unsupported("a malformed WINDOW clause");
      this.windowDef(w.WindowDef, scope);
    }
    for (const d of stmt.distinctClause ?? []) {
      // Plain DISTINCT is a list holding one empty node.
      if (kindOf(d) === null && Object.keys(d).length === 0) continue;
      this.sortExpr(d, scope, out);
    }
    for (const s of stmt.sortClause ?? []) {
      if (!("SortBy" in s)) throw unsupported("a malformed ORDER BY");
      this.sortBy(s.SortBy, scope, out);
    }
    this.limits(stmt, scope);
    return out;
  }

  private values(rows: Node[], scope: Scope): OutputColumn[] {
    let width = -1;
    let cols: Lineage[] = [];
    for (const row of rows) {
      if (!("List" in row)) throw unsupported("a malformed VALUES row");
      const items = row.List.items ?? [];
      if (width === -1) {
        width = items.length;
        cols = items.map(() => []);
      } else if (items.length !== width) {
        throw unresolved("the VALUES rows have different lengths");
      }
      items.forEach((item, i) => {
        cols[i] = unionLineage(cols[i] ?? [], this.expr(item, scope));
      });
    }
    return cols.map((lineage, i) => ({ name: `column${i + 1}`, lineage }));
  }

  private limits(stmt: SelectStmt, scope: Scope): void {
    if (stmt.limitCount) this.expr(stmt.limitCount, scope);
    if (stmt.limitOffset) this.expr(stmt.limitOffset, scope);
  }

  /** INSERT; returns its RETURNING output. */
  insert(stmt: InsertStmt, env: Env): OutputColumn[] {
    const scope = this.newScope(env);
    if (stmt.withClause) this.withClause(stmt.withClause, scope);
    const target = this.writeTarget(stmt.relation, scope);
    const targetItem: NsItem = {
      rte: target,
      relVisible: true,
      colsVisible: true,
    };

    for (const c of stmt.cols ?? []) {
      if (!("ResTarget" in c))
        throw unsupported("a malformed INSERT column list");
      if (c.ResTarget.indirection?.length) {
        throw unsupported("a subscript or field in an INSERT column list");
      }
      this.targetColumn(target, c.ResTarget.name);
    }
    const source = stmt.selectStmt;
    if (source) {
      if (!("SelectStmt" in source))
        throw unsupported("a non-SELECT INSERT source");
      const outs = this.select(source.SelectStmt, {
        parent: null,
        cteParent: scope,
      });
      this.store(...outs.map((o) => o.lineage));
    }

    const oc = stmt.onConflictClause;
    if (oc) {
      const inferScope: Scope = {
        items: [targetItem],
        parent: null,
        ctes: new Map(),
        cteParent: scope,
      };
      for (const e of oc.infer?.indexElems ?? []) {
        if (!("IndexElem" in e))
          throw unsupported("a malformed ON CONFLICT target");
        const ie = e.IndexElem;
        if (ie.name) {
          this.targetColumn(target, ie.name);
          if (this.recording) this.arbiterColumns.push(ie.name);
        }
        if (ie.expr) this.expr(ie.expr, inferScope);
      }
      if (oc.infer?.whereClause) this.expr(oc.infer.whereClause, inferScope);
      if (oc.action === "ONCONFLICT_UPDATE") {
        const excluded: Rte = {
          kind: "excluded",
          refname: "excluded",
          columns: target.columns.map((c) => ({ name: c.name, lineage: [] })),
        };
        const updScope: Scope = {
          items: [
            targetItem,
            { rte: excluded, relVisible: true, colsVisible: false },
          ],
          parent: null,
          ctes: new Map(),
          cteParent: scope,
        };
        this.setList(oc.targetList ?? [], target, updScope);
        if (oc.whereClause) this.expr(oc.whereClause, updScope);
      } else if (oc.action !== "ONCONFLICT_NOTHING") {
        throw unsupported(`ON CONFLICT action ${oc.action ?? "(none)"}`);
      }
    }
    return this.returning(stmt.returningClause, target, [targetItem], scope);
  }

  /** UPDATE; returns its RETURNING output. */
  update(stmt: UpdateStmt, env: Env): OutputColumn[] {
    const scope = this.newScope(env);
    if (stmt.withClause) this.withClause(stmt.withClause, scope);
    const target = this.writeTarget(stmt.relation, scope);
    const targetItem: NsItem = {
      rte: target,
      relVisible: true,
      colsVisible: true,
    };
    scope.items.push(targetItem);
    const from: NsItem[] = [];
    for (const item of stmt.fromClause ?? []) {
      const added = this.fromItem(item, scope, from);
      from.push(...added);
      scope.items.push(...added);
    }
    this.setList(stmt.targetList ?? [], target, scope);
    if (stmt.whereClause) this.expr(stmt.whereClause, scope);
    return this.returning(stmt.returningClause, target, scope.items, scope);
  }

  /** DELETE; returns its RETURNING output. */
  delete(stmt: DeleteStmt, env: Env): OutputColumn[] {
    const scope = this.newScope(env);
    if (stmt.withClause) this.withClause(stmt.withClause, scope);
    const target = this.writeTarget(stmt.relation, scope);
    scope.items.push({ rte: target, relVisible: true, colsVisible: true });
    const using: NsItem[] = [];
    for (const item of stmt.usingClause ?? []) {
      const added = this.fromItem(item, scope, using);
      using.push(...added);
      scope.items.push(...added);
    }
    if (stmt.whereClause) this.expr(stmt.whereClause, scope);
    return this.returning(stmt.returningClause, target, scope.items, scope);
  }

  /** A relation named by DDL (not a FROM item): checked, recorded, never wrapped. */
  ddlRelation(rv: RangeVar | undefined, position: "read" | "write"): Relation {
    if (!rv?.relname) throw unsupported("a statement without a relation");
    this.visited.add(rv);
    if (rv.catalogname) throw unsupported("a database-qualified relation name");
    const relation = this.catalog.resolve(rv.schemaname ?? null, rv.relname);
    if (!relation) throw unresolved(`relation "${display(rv)}" does not exist`);
    if (position === "write") assertWritable(relation, true);
    const rte = this.relationRte(relation, rv);
    this.record({
      node: null,
      rv,
      relation,
      key: relationKey(relation.schema, relation.name),
      position,
      rte,
    });
    return relation;
  }

  /** Mark a DDL subtree analyzed, recording its calls and the relations it reads. */
  ddlSubtree(node: unknown, exclude: ReadonlySet<object> = new Set()): void {
    if (Array.isArray(node)) {
      for (const n of node) this.ddlSubtree(n, exclude);
      return;
    }
    if (!node || typeof node !== "object" || exclude.has(node)) return;
    const o = node as Record<string, unknown>;
    this.visited.add(o);
    if ("SelectStmt" in o || "SubLink" in o) {
      throw unsupported("a subquery inside a schema change");
    }
    if ("RangeVar" in o) {
      this.ddlRelation(o.RangeVar as RangeVar, "read");
      return;
    }
    if (isInlineRangeVar(o)) {
      this.ddlRelation(o as RangeVar, "read");
      return;
    }
    if ("FuncCall" in o) this.recordFunction(o.FuncCall as FuncCall);
    if ("A_Expr" in o) this.recordOperator(o.A_Expr as A_Expr);
    for (const v of Object.values(o)) this.ddlSubtree(v, exclude);
  }

  // ── FROM ──────────────────────────────────────────────────────────────────

  /** Items one FROM entry adds; `before` are the items LATERAL may see. */
  private fromItem(node: Node, scope: Scope, before: NsItem[]): NsItem[] {
    if ("RangeVar" in node) return [this.rangeVar(node, node.RangeVar, scope)];
    if ("RangeSubselect" in node) {
      return [this.rangeSubselect(node.RangeSubselect, scope, before)];
    }
    if ("RangeFunction" in node) {
      return [this.rangeFunction(node.RangeFunction, scope, before)];
    }
    if ("JoinExpr" in node) return this.join(node.JoinExpr, scope, before);
    if ("RangeTableSample" in node) {
      const ts = node.RangeTableSample;
      const rel = ts.relation;
      if (!rel || !("RangeVar" in rel)) {
        throw unsupported("TABLESAMPLE on something other than a table");
      }
      const item = this.rangeVar(rel, rel.RangeVar, scope);
      const use = this.uses.find((u) => u.node === rel);
      if (use) use.sampled = true;
      for (const a of ts.args ?? []) this.expr(a, scope);
      if (ts.repeatable) this.expr(ts.repeatable, scope);
      return [item];
    }
    throw unsupported(`a ${kindOf(node) ?? "malformed"} item in FROM`);
  }

  private lateralScope(scope: Scope, before: NsItem[]): Scope {
    return {
      items: before,
      parent: scope.parent,
      ctes: new Map(),
      cteParent: scope,
    };
  }

  private rangeVar(node: Node, rv: RangeVar, scope: Scope): NsItem {
    this.visited.add(rv);
    if (rv.catalogname) throw unsupported("a database-qualified relation name");
    const name = rv.relname ?? "";
    if (!rv.schemaname) {
      const cte = this.lookupCte(scope, name);
      if (cte) {
        if (cte.columns === "pending") {
          throw unsupported("a reference to a later query in WITH RECURSIVE");
        }
        const rte: Rte = {
          kind: "cte",
          refname: rv.alias?.aliasname ?? name,
          columns: applyAlias(cte.columns, rv.alias),
        };
        return { rte, relVisible: true, colsVisible: true };
      }
    }
    const relation = this.catalog.resolve(rv.schemaname ?? null, name);
    if (!relation) throw unresolved(`relation "${display(rv)}" does not exist`);
    const rte = this.relationRte(relation, rv);
    const key = relationKey(relation.schema, relation.name);
    if (this.recording) {
      this.record({ node, rv, relation, key, position: "read", rte });
    } else if (this.viewStack.length > 0 && this.silent === 0) {
      this.viewUses.push({
        key,
        relation,
        view: this.viewStack[0] ?? "",
      });
    }
    return { rte, relVisible: true, colsVisible: true };
  }

  private record(use: RelationUse): void {
    this.uses.push(use);
    this.hooks.onRelation(use);
  }

  private relationRte(relation: Relation, rv: RangeVar): Rte {
    const isView =
      relation.kind === "view" || relation.kind === "materialized_view";
    const columns = isView
      ? this.viewColumns(relation)
      : relation.columns.map((c) => ({
          name: c.name,
          lineage: [
            { schema: relation.schema, table: relation.name, column: c.name },
          ],
        }));
    return {
      kind: isView ? "view" : "relation",
      refname: rv.alias?.aliasname ?? relation.name,
      columns: applyAlias(columns, rv.alias),
      relation,
      unaliased: !rv.alias,
    };
  }

  /** A view's columns, traced through its definition. */
  private viewColumns(view: Relation): RteColumn[] {
    const key = relationKey(view.schema, view.name);
    const own = view.columns.map((c) => ({
      name: c.name,
      lineage: [{ schema: view.schema, table: view.name, column: c.name }],
    }));
    if (!view.definition) {
      // System views describe the catalog, never row data.
      if (
        view.schema === "information_schema" ||
        view.schema === "pg_catalog"
      ) {
        return own;
      }
      throw unresolved(
        `view "${key}" has no definition in the catalog snapshot, so what it reads can't be traced`,
      );
    }
    if (
      this.viewStack.includes(key) ||
      this.viewStack.length >= MAX_VIEW_DEPTH
    ) {
      throw unresolved(`view "${key}" nests too deeply to trace`);
    }
    const def = this.parseDefinition(view.definition);
    if (!def) {
      throw unresolved(
        `the definition of view "${key}" is not a single SELECT`,
      );
    }
    this.viewStack.push(key);
    let outs: OutputColumn[];
    try {
      outs = this.select(def, { parent: null, cteParent: null });
    } finally {
      this.viewStack.pop();
    }
    if (outs.length !== view.columns.length) {
      throw unresolved(
        `the definition of view "${key}" doesn't match its columns`,
      );
    }
    return view.columns.map((c, i) => ({
      name: c.name,
      lineage: outs[i]?.lineage ?? [],
    }));
  }

  /** Set by the caller: parses a view definition to one SelectStmt. */
  parseDefinition: (sql: string) => SelectStmt | null = () => null;

  private rangeSubselect(
    rs: RangeSubselect,
    scope: Scope,
    before: NsItem[],
  ): NsItem {
    const sub = rs.subquery;
    if (!sub || !("SelectStmt" in sub))
      throw unsupported("a non-SELECT subquery in FROM");
    const env: Env = rs.lateral
      ? { parent: this.lateralScope(scope, before), cteParent: scope }
      : { parent: scope.parent, cteParent: scope };
    const outs = this.select(sub.SelectStmt, env);
    const rte: Rte = {
      kind: "subquery",
      refname: rs.alias?.aliasname ?? null,
      columns: applyAlias(outs, rs.alias),
    };
    return { rte, relVisible: rte.refname !== null, colsVisible: true };
  }

  private rangeFunction(
    rf: RangeFunction,
    scope: Scope,
    before: NsItem[],
  ): NsItem {
    if (rf.is_rowsfrom) throw unsupported("ROWS FROM");
    if (rf.coldeflist?.length)
      throw unsupported("a column definition list on a function");
    const fns = rf.functions ?? [];
    if (fns.length !== 1)
      throw unsupported("more than one function in one FROM item");
    const pair = fns[0];
    if (!pair || !("List" in pair))
      throw unsupported("a malformed function in FROM");
    const [call, coldefs] = pair.List.items ?? [];
    if (!call || !("FuncCall" in call))
      throw unsupported("a non-function call in FROM");
    if (coldefs && kindOf(coldefs) !== null) {
      throw unsupported("a column definition list on a function");
    }
    // Functions in FROM see earlier items without saying LATERAL.
    const lineage = this.expr(call, this.lateralScope(scope, before));
    const fnName = qualNameOf(call.FuncCall.funcname)?.name ?? "?column?";
    const argc = call.FuncCall.args?.length ?? 0;
    const known =
      SINGLE_COLUMN_SRFS.has(fnName.toLowerCase()) ||
      (fnName.toLowerCase() === "unnest" && argc === 1);
    const columns: RteColumn[] = [
      { name: rf.alias?.aliasname ?? fnName, lineage },
    ];
    if (rf.ordinality) columns.push({ name: "ordinality", lineage: [] });
    // An alias list names every column of an unknown-shape function.
    const aliased = rf.alias?.colnames ? names(rf.alias.colnames) : [];
    const rte: Rte =
      !known && aliased.length > 0
        ? {
            kind: "function",
            refname: rf.alias?.aliasname ?? fnName,
            columns: aliased.map((name) => ({ name, lineage })),
          }
        : {
            kind: "function",
            refname: rf.alias?.aliasname ?? fnName,
            columns: applyAlias(columns, rf.alias),
            opaque: !known,
          };
    return { rte, relVisible: true, colsVisible: true };
  }

  private join(j: JoinExpr, scope: Scope, before: NsItem[]): NsItem[] {
    if (j.join_using_alias) throw unsupported("an alias on JOIN ... USING");
    if (!j.larg || !j.rarg) throw unsupported("an incomplete JOIN");
    const left = this.fromItem(j.larg, scope, before);
    const right = this.fromItem(j.rarg, scope, [...before, ...left]);
    const lcols = visibleColumns(left);
    const rcols = visibleColumns(right);
    if (j.isNatural && [...left, ...right].some((i) => i.rte.opaque)) {
      throw unsupported(
        "a NATURAL join with a function whose columns are unknown",
      );
    }

    let using: string[] = [];
    if (j.isNatural) {
      const rnames = new Set(rcols.map((c) => c.name));
      using = lcols.map((c) => c.name).filter((n) => rnames.has(n));
    } else if (j.usingClause) {
      using = names(j.usingClause);
    }
    const merged: RteColumn[] = using.map((name) => {
      const l = lcols.filter((c) => c.name === name);
      const r = rcols.filter((c) => c.name === name);
      if (l.length !== 1 || r.length !== 1) {
        throw unresolved(
          `the join column "${name}" is not exactly one column on each side`,
        );
      }
      return {
        name,
        lineage: unionLineage(l[0]?.lineage ?? [], r[0]?.lineage ?? []),
      };
    });
    const usingSet = new Set(using);
    const joinCols = [
      ...merged,
      ...lcols.filter((c) => !usingSet.has(c.name)),
      ...rcols.filter((c) => !usingSet.has(c.name)),
    ];

    if (j.quals) {
      const qscope: Scope = {
        items: [...left, ...right],
        parent: scope.parent,
        ctes: new Map(),
        cteParent: scope,
      };
      this.expr(j.quals, qscope);
    }

    if (j.alias) {
      const rte: Rte = {
        kind: "join",
        refname: j.alias.aliasname ?? null,
        columns: applyAlias(joinCols, j.alias),
      };
      return [{ rte, relVisible: true, colsVisible: true }];
    }
    for (const item of [...left, ...right]) item.colsVisible = false;
    const rte: Rte = { kind: "join", refname: null, columns: joinCols };
    return [...left, ...right, { rte, relVisible: false, colsVisible: true }];
  }

  // ── WITH ──────────────────────────────────────────────────────────────────

  private withClause(wc: WithClause, scope: Scope): void {
    const ctes: CommonTableExpr[] = [];
    for (const c of wc.ctes ?? []) {
      if (!("CommonTableExpr" in c)) throw unsupported("a malformed WITH item");
      ctes.push(c.CommonTableExpr);
    }
    if (wc.recursive) {
      for (const cte of ctes)
        scope.ctes.set(cte.ctename ?? "", { columns: "pending" });
    }
    const env: Env = { parent: scope.parent, cteParent: scope };
    for (const cte of ctes) {
      const name = cte.ctename ?? "";
      if (cte.search_clause || cte.cycle_clause) {
        throw unsupported("SEARCH or CYCLE in WITH RECURSIVE");
      }
      const q = cte.ctequery;
      const kind = kindOf(q);
      if (
        kind === "InsertStmt" ||
        kind === "UpdateStmt" ||
        kind === "DeleteStmt" ||
        kind === "MergeStmt"
      ) {
        throw new Deny(
          "hidden_write",
          `Midplane denied this query because the WITH query "${name}" contains ${kind.replace(/Stmt$/, "").toUpperCase()}. A write nested inside another statement is never allowed; send the write as its own statement.`,
        );
      }
      if (!q || !("SelectStmt" in q))
        throw unsupported(`a ${kind ?? "malformed"} WITH query`);
      const body = q.SelectStmt;
      let columns: RteColumn[];
      if (wc.recursive && mentionsRelation(body, name)) {
        columns = this.recursiveCte(name, cte, body, scope, env);
      } else {
        columns = this.select(body, env);
      }
      scope.ctes.set(name, { columns: this.cteAlias(cte, columns) });
    }
  }

  private cteAlias(cte: CommonTableExpr, columns: RteColumn[]): RteColumn[] {
    return applyAlias(columns, {
      aliasname: cte.ctename ?? "",
      colnames: cte.aliascolnames ?? [],
    });
  }

  /** A self-referencing CTE: its lineage is the fixpoint over its recursive arm. */
  private recursiveCte(
    name: string,
    cte: CommonTableExpr,
    body: SelectStmt,
    scope: Scope,
    env: Env,
  ): RteColumn[] {
    if (body.op !== "SETOP_UNION" || !body.larg || !body.rarg) {
      throw unsupported("a recursive WITH query that isn't a UNION");
    }
    if (body.withClause || body.sortClause?.length || body.limitCount) {
      throw unsupported("WITH, ORDER BY or LIMIT on a recursive WITH query");
    }
    this.visited.add(body);
    let columns = this.cteAlias(cte, this.select(body.larg, env));
    for (let pass = 0; ; pass++) {
      scope.ctes.set(name, { columns });
      if (pass > 0) this.silent++;
      let right: OutputColumn[];
      try {
        right = this.select(body.rarg, env);
      } finally {
        if (pass > 0) this.silent--;
      }
      if (right.length !== columns.length) {
        throw unresolved(
          `the two halves of recursive query "${name}" return different numbers of columns`,
        );
      }
      let grew = false;
      const next = columns.map((c, i) => {
        const lineage = unionLineage(c.lineage, right[i]?.lineage ?? []);
        if (lineage.length !== c.lineage.length) grew = true;
        return { name: c.name, lineage };
      });
      columns = next;
      if (!grew) return columns;
    }
  }

  // ── target lists ──────────────────────────────────────────────────────────

  private targetList(
    list: Node[],
    scope: Scope,
    returning: boolean,
  ): OutputColumn[] {
    const out: OutputColumn[] = [];
    for (const item of list) {
      if (!("ResTarget" in item)) throw unsupported("a malformed select list");
      const rt: ResTarget = item.ResTarget;
      if (rt.indirection?.length)
        throw unsupported("a subscript on an output name");
      const val = rt.val;
      if (!val) throw unsupported("an empty select-list item");
      const star = this.starColumns(val, scope);
      if (star) {
        out.push(...star);
        continue;
      }
      const bare = returning && "ColumnRef" in val;
      out.push({
        name: rt.name ?? figureColname(val),
        lineage: this.expr(val, scope, bare),
      });
    }
    return out;
  }

  /** `*`, `t.*` and `(t).*` in a select list: the columns they expand to. */
  private starColumns(val: Node, scope: Scope): OutputColumn[] | null {
    if ("ColumnRef" in val) {
      const fields = val.ColumnRef.fields ?? [];
      const last = fields[fields.length - 1];
      if (!last || !("A_Star" in last)) return null;
      this.visited.add(val.ColumnRef);
      if (fields.length === 1) {
        const cols: OutputColumn[] = [];
        for (const item of scope.items) {
          if (!item.colsVisible) continue;
          if (item.rte.opaque) throw opaqueStar();
          this.bind(val.ColumnRef, item.rte, null, false, false);
          cols.push(...item.rte.columns);
        }
        return cols;
      }
      const rte = this.findRte(fields.slice(0, -1), scope, val.ColumnRef);
      if (rte.opaque) throw opaqueStar();
      this.bind(val.ColumnRef, rte, null, fields.length > 2, false);
      return [...rte.columns];
    }
    if ("A_Indirection" in val) {
      const ind = val.A_Indirection.indirection ?? [];
      const last = ind[ind.length - 1];
      if (!last || !("A_Star" in last)) return null;
      const arg = val.A_Indirection.arg;
      if (ind.length === 1 && arg && "ColumnRef" in arg) {
        const fields = arg.ColumnRef.fields ?? [];
        if (fields.length === 1) {
          const rte = this.findRte(fields, scope, arg.ColumnRef);
          this.visited.add(arg.ColumnRef);
          this.bind(arg.ColumnRef, rte, null, false, false);
          return [...rte.columns];
        }
      }
      throw unsupported("expanding a composite value with .*");
    }
    return null;
  }

  private setList(list: Node[], target: Rte, scope: Scope): void {
    for (const item of list) {
      if (!("ResTarget" in item)) throw unsupported("a malformed SET list");
      const rt = item.ResTarget;
      if (rt.indirection?.length)
        throw unsupported("a subscript or field in a SET target");
      this.targetColumn(target, rt.name);
      const val = rt.val;
      if (!val) throw unsupported("an empty SET item");
      if ("MultiAssignRef" in val) {
        const m = val.MultiAssignRef;
        // Each column of a (a, b) = (...) group carries its own copy of the
        // source; every copy is analyzed, since each is part of the tree.
        if (m.source) this.store(this.expr(m.source, scope, false, true));
        continue;
      }
      this.store(this.expr(val, scope));
    }
  }

  /** Record lineage a write stores. */
  store(...lineages: Lineage[]): void {
    if (this.recording) this.written.push(...unionLineage(...lineages));
  }

  private targetColumn(target: Rte, name: string | undefined): void {
    if (!name || !target.columns.some((c) => c.name === name)) {
      throw unresolved(
        `column "${name ?? ""}" of relation "${target.refname ?? ""}" does not exist`,
      );
    }
  }

  private returning(
    rc: ReturningClause | undefined,
    target: Rte,
    items: NsItem[],
    scope: Scope,
  ): OutputColumn[] {
    const exprs = rc?.exprs ?? [];
    if (exprs.length === 0) return [];
    if (rc?.options?.length)
      throw unsupported("RETURNING WITH (OLD/NEW AS ...)");
    const rscope: Scope = {
      items: [...items],
      parent: null,
      ctes: new Map(),
      cteParent: scope,
    };
    // Postgres 18: `old` and `new` qualify the target in RETURNING.
    for (const alias of ["old", "new"]) {
      if (!items.some((i) => i.relVisible && i.rte.refname === alias)) {
        rscope.items.push({
          rte: { ...target, refname: alias, columns: target.columns },
          relVisible: true,
          colsVisible: false,
        });
      }
    }
    return this.targetList(exprs, rscope, true);
  }

  private writeTarget(rv: RangeVar | undefined, _scope: Scope): Rte {
    if (!rv?.relname) throw unsupported("a write without a target");
    this.visited.add(rv);
    if (rv.catalogname) throw unsupported("a database-qualified relation name");
    const relation = this.catalog.resolve(rv.schemaname ?? null, rv.relname);
    if (!relation) throw unresolved(`relation "${display(rv)}" does not exist`);
    assertWritable(relation, false);
    const rte = this.relationRte(relation, rv);
    rte.target = true;
    this.record({
      node: null,
      rv,
      relation,
      key: relationKey(relation.schema, relation.name),
      position: "write",
      rte,
    });
    return rte;
  }

  // ── ORDER BY, GROUP BY, WINDOW ───────────────────────────────────────────

  private outputOnlySort(sort: Node[] | undefined, out: OutputColumn[]): void {
    for (const s of sort ?? []) {
      if (!("SortBy" in s)) throw unsupported("a malformed ORDER BY");
      const node = s.SortBy.node;
      this.recordSortOp(s.SortBy);
      if (node && this.outputReference(node, out)) continue;
      throw unsupported("an ORDER BY expression on a set operation or VALUES");
    }
  }

  private sortBy(s: SortBy, scope: Scope, out: OutputColumn[]): void {
    this.recordSortOp(s);
    if (s.node) this.sortExpr(s.node, scope, out);
  }

  private recordSortOp(s: SortBy): void {
    if (s.useOp) {
      const op = qualNameOf(s.useOp);
      if (op && this.recording) this.operators.push(op);
    }
  }

  /** ORDER BY and DISTINCT ON: an output name or position first, then an expression. */
  private sortExpr(node: Node, scope: Scope, out: OutputColumn[]): void {
    if (this.outputReference(node, out)) return;
    this.expr(node, scope);
  }

  /** GROUP BY: an input column first, then an output name or position. */
  private groupItem(node: Node, scope: Scope, out: OutputColumn[]): void {
    if ("GroupingSet" in node) {
      for (const c of node.GroupingSet.content ?? [])
        this.groupItem(c, scope, out);
      return;
    }
    const single = singleName(node);
    if (single !== null && !this.inputColumnAtLevel(single, scope)) {
      if (this.outputReference(node, out)) return;
    }
    if ("A_Const" in node && this.outputReference(node, out)) return;
    this.expr(node, scope);
  }

  /** True if `node` names an output column by position or by a unique name. */
  private outputReference(node: Node, out: OutputColumn[]): boolean {
    if ("A_Const" in node && node.A_Const.ival !== undefined) {
      const pos = node.A_Const.ival.ival ?? 0;
      if (pos < 1 || pos > out.length) {
        throw unresolved(`position ${pos} is not in the select list`);
      }
      return true;
    }
    const single = singleName(node);
    if (single === null) return false;
    const matches = out.filter((c) => c.name === single).length;
    if (matches > 1)
      throw unresolved(`"${single}" is ambiguous in the select list`);
    if (matches === 1 && "ColumnRef" in node) this.visited.add(node.ColumnRef);
    return matches === 1;
  }

  private inputColumnAtLevel(name: string, scope: Scope): boolean {
    return scope.items.some(
      (i) => i.colsVisible && i.rte.columns.some((c) => c.name === name),
    );
  }

  private windowDef(
    w: {
      partitionClause?: Node[];
      orderClause?: Node[];
      startOffset?: Node;
      endOffset?: Node;
    },
    scope: Scope,
  ): void {
    for (const p of w.partitionClause ?? []) this.expr(p, scope);
    for (const o of w.orderClause ?? []) {
      if (!("SortBy" in o)) throw unsupported("a malformed window ORDER BY");
      this.recordSortOp(o.SortBy);
      if (o.SortBy.node) this.expr(o.SortBy.node, scope);
    }
    if (w.startOffset) this.expr(w.startOffset, scope);
    if (w.endOffset) this.expr(w.endOffset, scope);
  }

  // ── column references ─────────────────────────────────────────────────────

  private bind(
    ref: ColumnRef,
    rte: Rte,
    column: string | null,
    schemaQualified: boolean,
    bareReturning: boolean,
  ): void {
    if (!this.recording) return;
    this.bindings.push({ ref, rte, column, schemaQualified, bareReturning });
  }

  /** The RTE a qualifier (`t` or `schema.t`) names, innermost level first. */
  private findRte(qual: Node[], scope: Scope, ref: ColumnRef): Rte {
    const parts = names(qual);
    if (parts.length > 2)
      throw unsupported("a database-qualified column reference");
    const [a, b] = parts;
    for (let s: Scope | null = scope; s; s = s.parent) {
      const matches = s.items.filter((i) => {
        if (!i.relVisible) return false;
        if (parts.length === 1) return i.rte.refname === a;
        return (
          i.rte.unaliased === true &&
          i.rte.relation?.schema === a &&
          i.rte.relation?.name === b
        );
      });
      if (matches.length > 1) {
        throw unresolved(
          `the table reference "${parts.join(".")}" is ambiguous`,
        );
      }
      const hit = matches[0];
      if (hit) return hit.rte;
    }
    void ref;
    throw unresolved(`there is no FROM-clause entry for "${parts.join(".")}"`);
  }

  private columnRef(
    ref: ColumnRef,
    scope: Scope,
    bareReturning: boolean,
  ): Lineage {
    this.visited.add(ref);
    const fields = ref.fields ?? [];
    const last = fields[fields.length - 1];
    if (!last) throw unsupported("an empty column reference");
    if ("A_Star" in last) {
      if (fields.length === 1)
        throw unsupported("a bare * outside a select list");
      const rte = this.findRte(fields.slice(0, -1), scope, ref);
      this.bind(ref, rte, null, fields.length > 2, false);
      return unionLineage(...rte.columns.map((c) => c.lineage));
    }
    const parts = names(fields);
    const col = parts[parts.length - 1] ?? "";

    if (parts.length === 1) {
      for (let s: Scope | null = scope; s; s = s.parent) {
        const hits: { rte: Rte; column: RteColumn }[] = [];
        for (const item of s.items) {
          if (!item.colsVisible) continue;
          for (const c of item.rte.columns) {
            if (c.name === col) hits.push({ rte: item.rte, column: c });
          }
        }
        if (hits.length > 1)
          throw unresolved(`column reference "${col}" is ambiguous`);
        const hit = hits[0];
        if (hit) {
          this.bind(
            ref,
            this.bindingRte(hit.rte, col, s),
            col,
            false,
            bareReturning,
          );
          return hit.column.lineage;
        }
      }
      // No column by that name: Postgres reads a bare relation name as its whole row.
      for (let s: Scope | null = scope; s; s = s.parent) {
        const item = s.items.find((i) => i.relVisible && i.rte.refname === col);
        if (item) {
          this.bind(ref, item.rte, null, false, false);
          return unionLineage(...item.rte.columns.map((c) => c.lineage));
        }
      }
      throw unresolved(`column "${col}" does not exist`);
    }

    const rte = this.findRte(fields.slice(0, -1), scope, ref);
    const matches = rte.columns.filter((c) => c.name === col);
    if (matches.length > 1)
      throw unresolved(`column reference "${parts.join(".")}" is ambiguous`);
    const match = matches[0];
    if (!match) {
      if (rte.opaque) throw opaqueStar();
      throw unresolved(`column "${parts.join(".")}" does not exist`);
    }
    this.bind(ref, rte, col, parts.length > 2, bareReturning);
    return match.lineage;
  }

  /**
   * An unqualified name found through a join resolves to a join column; for
   * the write-target checks, attribute it to the base RTE it came from.
   */
  private bindingRte(rte: Rte, col: string, scope: Scope): Rte {
    if (rte.kind !== "join") return rte;
    const inner = scope.items.filter(
      (i) => !i.colsVisible && i.rte.columns.some((c) => c.name === col),
    );
    return inner.length === 1 && inner[0] ? inner[0].rte : rte;
  }

  // ── expressions ───────────────────────────────────────────────────────────

  private recordFunction(fc: FuncCall): void {
    this.visited.add(fc);
    const q = qualNameOf(fc.funcname);
    if (!q) throw unsupported("a function with a malformed name");
    if (this.recording) this.functions.push(q);
    else if (this.silent === 0) this.viewFunctions.push(q);
  }

  private recordOperator(a: A_Expr): void {
    if (!this.recording) return;
    // BETWEEN is not an operator; Postgres expands it into >= and <=.
    if (a.kind?.includes("BETWEEN")) {
      this.operators.push(
        { schema: null, name: ">=" },
        { schema: null, name: "<=" },
      );
      return;
    }
    const q = qualNameOf(a.name);
    if (q) this.operators.push(q);
  }

  /**
   * The lineage of an expression's value. Conditions (WHERE, CASE WHEN,
   * EXISTS) are analyzed but contribute nothing: a boolean carries no content.
   */
  expr(
    node: Node,
    scope: Scope,
    bareReturning = false,
    multi = false,
  ): Lineage {
    if ("ColumnRef" in node)
      return this.columnRef(node.ColumnRef, scope, bareReturning);
    if (
      "A_Const" in node ||
      "SQLValueFunction" in node ||
      "SetToDefault" in node
    ) {
      return [];
    }
    if ("ParamRef" in node) throw unsupported("a parameter placeholder ($1)");
    if ("A_Expr" in node) {
      const a = node.A_Expr;
      this.recordOperator(a);
      const l = a.lexpr ? this.expr(a.lexpr, scope) : [];
      const r = a.rexpr ? this.expr(a.rexpr, scope) : [];
      return a.kind === "AEXPR_OP" || a.kind === "AEXPR_NULLIF"
        ? unionLineage(l, r)
        : [];
    }
    if ("BoolExpr" in node) {
      for (const arg of node.BoolExpr.args ?? []) this.expr(arg, scope);
      return [];
    }
    if ("FuncCall" in node) {
      const fc = node.FuncCall;
      this.recordFunction(fc);
      const parts = (fc.args ?? []).map((a) => this.expr(a, scope));
      if (fc.agg_filter) this.expr(fc.agg_filter, scope);
      for (const o of fc.agg_order ?? []) {
        if (!("SortBy" in o))
          throw unsupported("a malformed aggregate ORDER BY");
        this.recordSortOp(o.SortBy);
        const sorted = o.SortBy.node ? this.expr(o.SortBy.node, scope) : [];
        // WITHIN GROUP (ORDER BY x): the result is one of the x values.
        if (fc.agg_within_group) parts.push(sorted);
      }
      if (fc.over) this.windowDef(fc.over, scope);
      return unionLineage(...parts);
    }
    if ("TypeCast" in node) {
      const type = qualNameOf(node.TypeCast.typeName?.names);
      if (!type) throw unsupported("a cast to a malformed type name");
      if (this.silent === 0) this.types.push(type);
      return node.TypeCast.arg ? this.expr(node.TypeCast.arg, scope) : [];
    }
    if ("CollateClause" in node) {
      return node.CollateClause.arg
        ? this.expr(node.CollateClause.arg, scope)
        : [];
    }
    if ("NamedArgExpr" in node) {
      return node.NamedArgExpr.arg
        ? this.expr(node.NamedArgExpr.arg, scope)
        : [];
    }
    if ("CaseExpr" in node) {
      const c = node.CaseExpr;
      if (c.arg) this.expr(c.arg, scope);
      const results: Lineage[] = [];
      for (const w of c.args ?? []) {
        if (!("CaseWhen" in w)) throw unsupported("a malformed CASE");
        if (w.CaseWhen.expr) this.expr(w.CaseWhen.expr, scope);
        if (w.CaseWhen.result)
          results.push(this.expr(w.CaseWhen.result, scope));
      }
      if (c.defresult) results.push(this.expr(c.defresult, scope));
      return unionLineage(...results);
    }
    if ("CoalesceExpr" in node) {
      return unionLineage(
        ...(node.CoalesceExpr.args ?? []).map((a) => this.expr(a, scope)),
      );
    }
    if ("MinMaxExpr" in node) {
      return unionLineage(
        ...(node.MinMaxExpr.args ?? []).map((a) => this.expr(a, scope)),
      );
    }
    if ("A_ArrayExpr" in node) {
      return unionLineage(
        ...(node.A_ArrayExpr.elements ?? []).map((a) => this.expr(a, scope)),
      );
    }
    if ("RowExpr" in node) {
      return unionLineage(
        ...(node.RowExpr.args ?? []).map((a) => this.expr(a, scope)),
      );
    }
    if ("List" in node) {
      return unionLineage(
        ...(node.List.items ?? []).map((a) => this.expr(a, scope)),
      );
    }
    if ("NullTest" in node) {
      if (node.NullTest.arg) this.expr(node.NullTest.arg, scope);
      return [];
    }
    if ("BooleanTest" in node) {
      if (node.BooleanTest.arg) this.expr(node.BooleanTest.arg, scope);
      return [];
    }
    if ("GroupingFunc" in node) {
      for (const a of node.GroupingFunc.args ?? []) this.expr(a, scope);
      return [];
    }
    if ("A_Indirection" in node) {
      const ind = node.A_Indirection;
      const base = ind.arg ? this.expr(ind.arg, scope) : [];
      for (const i of ind.indirection ?? []) {
        if ("A_Indices" in i) {
          if (i.A_Indices.lidx) this.expr(i.A_Indices.lidx, scope);
          if (i.A_Indices.uidx) this.expr(i.A_Indices.uidx, scope);
        } else if (!("String" in i)) {
          throw unsupported("this kind of field or subscript access");
        }
      }
      return base;
    }
    if ("SubLink" in node) return this.subLink(node.SubLink, scope, multi);
    throw unsupported(`the ${kindOf(node) ?? "unknown"} expression`);
  }

  private subLink(
    sl: {
      subLinkType?: string;
      testexpr?: Node;
      operName?: Node[];
      subselect?: Node;
    },
    scope: Scope,
    multi: boolean,
  ): Lineage {
    this.visited.add(sl);
    const sub = sl.subselect;
    if (!sub || !("SelectStmt" in sub))
      throw unsupported("a non-SELECT subquery");
    if (sl.testexpr) this.expr(sl.testexpr, scope);
    if (sl.operName) {
      const op = qualNameOf(sl.operName);
      if (op && this.recording) this.operators.push(op);
    }
    const outs = this.select(sub.SelectStmt, {
      parent: scope,
      cteParent: scope,
    });
    switch (sl.subLinkType) {
      case "EXISTS_SUBLINK":
      case "ANY_SUBLINK":
      case "ALL_SUBLINK":
      case "ROWCOMPARE_SUBLINK":
        return [];
      case "EXPR_SUBLINK":
      case "ARRAY_SUBLINK":
        if (outs.length !== 1 && !multi) {
          throw unresolved(
            "a subquery used as a value returns more than one column",
          );
        }
        return unionLineage(...outs.map((o) => o.lineage));
      case "MULTIEXPR_SUBLINK":
        return unionLineage(...outs.map((o) => o.lineage));
      default:
        throw unsupported(`a ${sl.subLinkType ?? "malformed"} subquery`);
    }
  }
}

/** System catalogs are never changed; schema changes apply to tables only. */
function assertWritable(relation: Relation, schemaChange: boolean): void {
  if (
    relation.schema === "pg_catalog" ||
    relation.schema === "information_schema"
  ) {
    throw unsupported("changing a system catalog");
  }
  const kind = relation.kind;
  if (kind === "view" || kind === "materialized_view") {
    throw unsupported(`changing a ${kind.replace("_", " ")}`);
  }
  if (schemaChange && kind === "foreign_table") {
    throw unsupported("a schema change on a foreign table");
  }
}

function opaqueStar(): Deny {
  return unsupported(
    "a function in FROM whose columns Midplane can't determine; name its columns with an alias list, as in f(...) AS x(a, b)",
  );
}

function visibleColumns(items: NsItem[]): RteColumn[] {
  return items.filter((i) => i.colsVisible).flatMap((i) => i.rte.columns);
}

function singleName(node: Node): string | null {
  if (!("ColumnRef" in node)) return null;
  const fields = node.ColumnRef.fields ?? [];
  return fields.length === 1 ? stringOf(fields[0]) : null;
}

/** A RangeVar serialized inline (a typed field) rather than as a `{ RangeVar }` node. */
function isInlineRangeVar(o: Record<string, unknown>): boolean {
  return typeof o.relname === "string" && typeof o.relpersistence === "string";
}

export function display(rv: RangeVar): string {
  return rv.schemaname
    ? `${rv.schemaname}.${rv.relname ?? ""}`
    : (rv.relname ?? "");
}

/**
 * Nodes that name data or run code. After analysis, any of these the resolver
 * never visited means a part of the tree was skipped, so the statement is
 * denied rather than trusted.
 */
const SWEPT = new Set([
  "RangeVar",
  "FuncCall",
  "ColumnRef",
  "SubLink",
  "SelectStmt",
]);

export function coverageGap(
  root: unknown,
  visited: WeakSet<object>,
): string | null {
  let gap: string | null = null;
  const walk = (node: unknown): void => {
    if (gap) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (isInlineRangeVar(o) && !visited.has(o)) {
      gap = "RangeVar";
      return;
    }
    const kind = kindOf(o);
    if (kind && SWEPT.has(kind)) {
      const inner = o[kind];
      if (inner && typeof inner === "object" && !visited.has(inner)) {
        gap = kind;
        return;
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return gap;
}
