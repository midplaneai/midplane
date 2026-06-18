// Single-walk AST visitor.
//
// Walks every node in the libpg-query parse tree exactly once, dispatching
// to all rule callbacks. Recursion is exhaustive — CTEs, subqueries,
// UNION arms, JOINs, function calls.
//
// AST shape note: most AST nodes are tagged-union wrappers like
// `{ SelectStmt: { ... } }`, but UNION/INTERSECT/EXCEPT operators put their
// arms in bare `larg`/`rarg` objects (not tagged). The visitor treats those
// bare objects as virtual SelectStmt scopes so rules see them with the
// correct `enclosingSelectStmt`.

import type { PgParseTree } from "./parse.ts";

export interface VisitorScope {
  depth: number;
  path: readonly string[];
  enclosingStmtKind: string | null;
  enclosingSelectStmt: Record<string, unknown> | null;
}

export interface VisitorRule {
  visit?(node: unknown, kind: string | null, scope: VisitorScope): void;
}

const STATEMENT_KINDS = new Set([
  "SelectStmt",
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
  "ExplainStmt",
  "VacuumStmt",
  "PrepareStmt",
  "DeallocateStmt",
  "TransactionStmt",
  "VariableSetStmt",
  "VariableShowStmt",
  "DoStmt",
  "ViewStmt",
  "IndexStmt",
  "RuleStmt",
  "NotifyStmt",
  "ListenStmt",
  "UnlistenStmt",
  "LockStmt",
  "ReindexStmt",
  "ClusterStmt",
  "RefreshMatViewStmt",
]);

export function isStatementKind(kind: string): boolean {
  return STATEMENT_KINDS.has(kind);
}

export function walk(tree: PgParseTree, rules: VisitorRule[]): void {
  for (const stmtWrapper of tree.stmts) {
    walkNode(stmtWrapper.stmt, rules, {
      depth: 0,
      path: [],
      enclosingStmtKind: null,
      enclosingSelectStmt: null,
    });
  }
}

function walkNode(value: unknown, rules: VisitorRule[], scope: VisitorScope): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) walkNode(item, rules, scope);
    return;
  }

  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Tagged-union shape: `{ SelectStmt: { ... } }` — single capitalized key
  // whose value is a plain object.
  if (keys.length === 1) {
    const kind = keys[0]!;
    const inner = obj[kind];
    const isTaggedUnion =
      inner !== null && typeof inner === "object" && !Array.isArray(inner) && /^[A-Z]/.test(kind);
    if (isTaggedUnion) {
      for (const r of rules) r.visit?.(inner, kind, scope);
      const innerObj = inner as Record<string, unknown>;
      const nextScope = enterScope(scope, kind, innerObj);
      walkInner(innerObj, kind, rules, nextScope);
      return;
    }
  }

  // Plain object — descend each property without changing scope.
  for (const k of keys) walkNode(obj[k], rules, scope);
}

function enterScope(
  scope: VisitorScope,
  kind: string,
  node: Record<string, unknown>,
): VisitorScope {
  if (isStatementKind(kind)) {
    return {
      depth: scope.depth + 1,
      path: [...scope.path, kind],
      enclosingStmtKind: kind,
      enclosingSelectStmt: kind === "SelectStmt" ? node : scope.enclosingSelectStmt,
    };
  }
  return { ...scope, depth: scope.depth + 1, path: [...scope.path, kind] };
}

// DML statement kinds whose `.relation` is a bare RangeVar-shaped object
// (no tagged-union wrapper). The visitor surfaces these as virtual RangeVars.
const DML_RELATION_OWNERS = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
]);

function walkInner(
  obj: Record<string, unknown>,
  kind: string,
  rules: VisitorRule[],
  scope: VisitorScope,
): void {
  // SelectStmt UNION/INTERSECT/EXCEPT: larg/rarg are bare SelectStmt-shaped
  // objects, not tagged. Treat each as a virtual SelectStmt scope so rules
  // see them with their own enclosingSelectStmt.
  if (kind === "SelectStmt") {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if ((k === "larg" || k === "rarg") && v && typeof v === "object" && !Array.isArray(v)) {
        const virt = v as Record<string, unknown>;
        const virtualScope: VisitorScope = {
          depth: scope.depth + 1,
          path: [...scope.path, "SelectStmt"],
          enclosingStmtKind: "SelectStmt",
          enclosingSelectStmt: virt,
        };
        for (const r of rules) r.visit?.(virt, "SelectStmt", virtualScope);
        walkInner(virt, "SelectStmt", rules, virtualScope);
      } else {
        walkNode(v, rules, scope);
      }
    }
    return;
  }

  // {Insert,Update,Delete,Merge}Stmt.relation is a bare RangeVar — dispatch
  // it explicitly so rules see all table references uniformly.
  if (DML_RELATION_OWNERS.has(kind)) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === "relation" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const r of rules) r.visit?.(v, "RangeVar", scope);
      }
      walkNode(v, rules, scope);
    }
    return;
  }

  for (const k of Object.keys(obj)) walkNode(obj[k], rules, scope);
}
