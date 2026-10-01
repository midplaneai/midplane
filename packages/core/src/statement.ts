// The classify stage: what kind of statement this is, whether it writes and
// in which class, and the analysis each supported kind needs. Statement kinds
// not listed here are denied.

import type { ApprovalClass, Relation } from "@midplane/protocol";
import type {
  AlterTableStmt,
  CreateStmt,
  CreateTableAsStmt,
  DropStmt,
  IndexStmt,
  IntoClause,
  Node,
  RangeVar,
  RenameStmt,
  SelectStmt,
} from "@pgsql/types";
import { kindOf, stringsOf } from "./ast.ts";
import { CREATION_SCHEMA, relationKey } from "./catalog.ts";
import { Deny, unsupported } from "./deny.ts";
import type { OutputColumn, Resolver } from "./resolve.ts";

export interface WriteInfo {
  class: ApprovalClass;
  /** Human keyword for messages, e.g. `UPDATE`, `DROP TABLE`. */
  operation: string;
}

/** Top-level classification, before any name is resolved. */
export interface Classification {
  kind: string;
  write: WriteInfo | null;
}

// ALTER TABLE subcommands that change a table's shape. Anything else (owner,
// row security, triggers, rules, storage options) could widen access or
// switch off one of the customer's own controls, so it is refused.
const ALTER_TABLE_ALLOWED = new Set([
  "AT_AddColumn",
  "AT_DropColumn",
  "AT_AlterColumnType",
  "AT_ColumnDefault",
  "AT_DropNotNull",
  "AT_SetNotNull",
  "AT_AddConstraint",
  "AT_DropConstraint",
  "AT_ValidateConstraint",
  "AT_AlterConstraint",
]);

const STATEMENT_NAMES: Record<string, string> = {
  ExplainStmt: "EXPLAIN",
  VariableSetStmt: "SET",
  VariableShowStmt: "SHOW",
  TransactionStmt: "transaction control (BEGIN, COMMIT, ROLLBACK)",
  CopyStmt: "COPY",
  CallStmt: "CALL",
  DoStmt: "DO",
  GrantStmt: "GRANT or REVOKE",
  GrantRoleStmt: "GRANT or REVOKE on a role",
  ViewStmt: "CREATE VIEW",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
  CreateFunctionStmt: "CREATE FUNCTION",
  CreateSchemaStmt: "CREATE SCHEMA",
  CreateRoleStmt: "CREATE ROLE",
  CreatedbStmt: "CREATE DATABASE",
  LockStmt: "LOCK",
  NotifyStmt: "NOTIFY",
  ListenStmt: "LISTEN",
  UnlistenStmt: "UNLISTEN",
  PrepareStmt: "PREPARE",
  ExecuteStmt: "EXECUTE",
  DeallocateStmt: "DEALLOCATE",
  DeclareCursorStmt: "DECLARE CURSOR",
  FetchStmt: "FETCH",
  ClosePortalStmt: "CLOSE",
  VacuumStmt: "VACUUM or ANALYZE",
  RuleStmt: "CREATE RULE",
  DiscardStmt: "DISCARD",
  CheckPointStmt: "CHECKPOINT",
  MergeStmt: "MERGE",
};

function statementName(kind: string): string {
  return (
    STATEMENT_NAMES[kind] ??
    kind
      .replace(/Stmt$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toUpperCase()
  );
}

function refuse(kind: string): Deny {
  return unsupported(`the ${statementName(kind)} statement`);
}

const rowChange = (operation: string): WriteInfo => ({
  class: "row_changes",
  operation,
});
const schemaChange = (operation: string): WriteInfo => ({
  class: "schema_changes",
  operation,
});

export function classify(stmt: Node): Classification {
  const kind = kindOf(stmt) ?? "unknown";
  if ("SelectStmt" in stmt) {
    const into = intoOf(stmt.SelectStmt);
    if (into) refuseTemporary(into.rel);
    return { kind, write: into ? rowChange("SELECT INTO") : null };
  }
  if ("InsertStmt" in stmt) return { kind, write: rowChange("INSERT") };
  if ("UpdateStmt" in stmt) return { kind, write: rowChange("UPDATE") };
  if ("DeleteStmt" in stmt) return { kind, write: rowChange("DELETE") };
  if ("CreateStmt" in stmt) {
    refuseTemporary(stmt.CreateStmt.relation);
    return { kind, write: rowChange("CREATE TABLE") };
  }
  if ("CreateTableAsStmt" in stmt) {
    if (stmt.CreateTableAsStmt.objtype !== "OBJECT_TABLE")
      throw refuse("CreateMatViewStmt");
    refuseTemporary(stmt.CreateTableAsStmt.into?.rel);
    return { kind, write: rowChange("CREATE TABLE AS") };
  }
  if ("IndexStmt" in stmt) return { kind, write: schemaChange("CREATE INDEX") };
  if ("AlterTableStmt" in stmt) {
    if (stmt.AlterTableStmt.objtype !== "OBJECT_TABLE") {
      throw unsupported(
        `ALTER on a ${objectName(stmt.AlterTableStmt.objtype)}`,
      );
    }
    for (const c of stmt.AlterTableStmt.cmds ?? []) {
      if (!("AlterTableCmd" in c)) throw unsupported("a malformed ALTER TABLE");
      const subtype = c.AlterTableCmd.subtype ?? "unknown";
      if (!ALTER_TABLE_ALLOWED.has(subtype)) {
        throw unsupported(
          `ALTER TABLE ${subtype
            .replace(/^AT_/, "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toUpperCase()}`,
        );
      }
    }
    return { kind, write: schemaChange("ALTER TABLE") };
  }
  if ("RenameStmt" in stmt) {
    const r = stmt.RenameStmt;
    const onTable =
      r.renameType === "OBJECT_TABLE" ||
      r.renameType === "OBJECT_TABCONSTRAINT" ||
      (r.renameType === "OBJECT_COLUMN" && r.relationType === "OBJECT_TABLE");
    if (!onTable) throw unsupported(`renaming a ${objectName(r.renameType)}`);
    return { kind, write: schemaChange("ALTER TABLE ... RENAME") };
  }
  if ("AlterObjectSchemaStmt" in stmt) {
    const o = stmt.AlterObjectSchemaStmt;
    if (o.objectType !== "OBJECT_TABLE") {
      throw unsupported(
        `moving a ${objectName(o.objectType)} to another schema`,
      );
    }
    return { kind, write: schemaChange("ALTER TABLE ... SET SCHEMA") };
  }
  if ("DropStmt" in stmt) {
    if (stmt.DropStmt.removeType !== "OBJECT_TABLE") {
      throw unsupported(`dropping a ${objectName(stmt.DropStmt.removeType)}`);
    }
    return { kind, write: schemaChange("DROP TABLE") };
  }
  if ("TruncateStmt" in stmt) {
    throw new Deny(
      "where_required",
      "Midplane denied this query because TRUNCATE removes every row of a table. Writes must name the rows they change: use DELETE with a WHERE clause.",
    );
  }
  throw refuse(kind);
}

/** The INTO of a SELECT INTO; over a set operation it sits on the leftmost arm. */
export function intoOf(s: SelectStmt): IntoClause | undefined {
  if (s.intoClause) return s.intoClause;
  if (s.op && s.op !== "SETOP_NONE" && s.larg) return intoOf(s.larg);
  return undefined;
}

function refuseTemporary(rv: RangeVar | undefined): void {
  if (rv?.relpersistence === "t") throw unsupported("a temporary table");
}

function objectName(objtype: string | undefined): string {
  return (objtype ?? "OBJECT_UNKNOWN")
    .replace(/^OBJECT_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
}

/** A table the statement creates. */
export interface Creation {
  rv: RangeVar;
  schema: string;
  name: string;
  key: string;
}

/** What analysis learned beyond the resolver's own records. */
export interface StatementAnalysis {
  output: OutputColumn[];
  /** UPDATE or DELETE, and whether it has a WHERE clause. */
  where: { operation: string; present: boolean; table: string } | null;
  creation: Creation | null;
  /** CREATE TABLE AS or SELECT INTO: the query that fills it, unless WITH NO DATA. */
  fill: SelectStmt | null;
  /** Tables the statement renames or moves. */
  renamed: Relation[];
  /** CREATE TABLE IF NOT EXISTS ... AS may copy nothing. */
  maybeEmpty?: boolean;
}

export interface AnalyzeHooks {
  /** Table-access check for a table the statement creates. */
  onCreate(creation: Creation): void;
}

function creationOf(rv: RangeVar | undefined, hooks: AnalyzeHooks): Creation {
  if (!rv?.relname) throw unsupported("a CREATE without a table name");
  if (rv.catalogname) throw unsupported("a database-qualified relation name");
  refuseTemporary(rv);
  const schema = rv.schemaname ?? CREATION_SCHEMA;
  const creation = {
    rv,
    schema,
    name: rv.relname,
    key: relationKey(schema, rv.relname),
  };
  hooks.onCreate(creation);
  return creation;
}

const TOP: { parent: null; cteParent: null } = {
  parent: null,
  cteParent: null,
};

export function analyze(
  stmt: Node,
  resolver: Resolver,
  hooks: AnalyzeHooks,
): StatementAnalysis {
  const result: StatementAnalysis = {
    output: [],
    where: null,
    creation: null,
    fill: null,
    renamed: [],
  };

  if ("SelectStmt" in stmt) {
    const s = stmt.SelectStmt;
    const into = intoOf(s);
    if (into) {
      resolver.visited.add(into);
      result.creation = creationOf(into.rel, hooks);
      resolver.visited.add(into.rel ?? {});
      if (!into.skipData) result.fill = s;
    }
    const output = resolver.select(s, TOP);
    if (into) resolver.store(...output.map((o) => o.lineage));
    else result.output = output;
    return result;
  }
  if ("InsertStmt" in stmt) {
    result.output = resolver.insert(stmt.InsertStmt, TOP);
    return result;
  }
  if ("UpdateStmt" in stmt) {
    const u = stmt.UpdateStmt;
    result.output = resolver.update(u, TOP);
    result.where = {
      operation: "UPDATE",
      present: u.whereClause !== undefined,
      table: tableName(u.relation),
    };
    return result;
  }
  if ("DeleteStmt" in stmt) {
    const d = stmt.DeleteStmt;
    result.output = resolver.delete(d, TOP);
    result.where = {
      operation: "DELETE",
      present: d.whereClause !== undefined,
      table: tableName(d.relation),
    };
    return result;
  }
  if ("CreateStmt" in stmt) {
    createTable(stmt.CreateStmt, resolver, hooks, result);
    return result;
  }
  if ("CreateTableAsStmt" in stmt) {
    createTableAs(stmt.CreateTableAsStmt, resolver, hooks, result);
    return result;
  }
  if ("IndexStmt" in stmt) {
    const s: IndexStmt = stmt.IndexStmt;
    resolver.ddlRelation(s.relation, "write");
    resolver.ddlSubtree(s, new Set(s.relation ? [s.relation] : []));
    return result;
  }
  if ("AlterTableStmt" in stmt) {
    alterTable(stmt.AlterTableStmt, resolver);
    return result;
  }
  if ("RenameStmt" in stmt) {
    const s: RenameStmt = stmt.RenameStmt;
    result.renamed.push(resolver.ddlRelation(s.relation, "write"));
    resolver.ddlSubtree(s, new Set(s.relation ? [s.relation] : []));
    return result;
  }
  if ("AlterObjectSchemaStmt" in stmt) {
    const s = stmt.AlterObjectSchemaStmt;
    result.renamed.push(resolver.ddlRelation(s.relation, "write"));
    resolver.ddlSubtree(s, new Set(s.relation ? [s.relation] : []));
    return result;
  }
  if ("DropStmt" in stmt) {
    dropTables(stmt.DropStmt, resolver);
    return result;
  }
  // classify() has already refused every other kind.
  throw refuse(kindOf(stmt) ?? "unknown");
}

function tableName(rv: RangeVar | undefined): string {
  if (!rv) return "the target table";
  return rv.schemaname
    ? `${rv.schemaname}.${rv.relname ?? ""}`
    : (rv.relname ?? "");
}

function createTable(
  s: CreateStmt,
  resolver: Resolver,
  hooks: AnalyzeHooks,
  result: StatementAnalysis,
): void {
  result.creation = creationOf(s.relation, hooks);
  const skip = new Set<object>();
  if (s.relation) {
    resolver.visited.add(s.relation);
    skip.add(s.relation);
  }
  // INHERITS and PARTITION OF put the new table's rows into the parent.
  for (const parent of s.inhRelations ?? []) {
    if (!("RangeVar" in parent)) throw unsupported("a malformed parent table");
    resolver.ddlRelation(parent.RangeVar, "write");
    skip.add(parent);
  }
  resolver.ddlSubtree(s, skip);
}

function createTableAs(
  s: CreateTableAsStmt,
  resolver: Resolver,
  hooks: AnalyzeHooks,
  result: StatementAnalysis,
): void {
  const into = s.into;
  if (!into) throw unsupported("CREATE TABLE AS without a target");
  result.creation = creationOf(into.rel, hooks);
  const query = s.query;
  if (!query || !("SelectStmt" in query)) {
    throw unsupported("CREATE TABLE AS over something other than a SELECT");
  }
  const output = resolver.select(query.SelectStmt, TOP);
  resolver.store(...output.map((o) => o.lineage));
  if (!into.skipData) result.fill = query.SelectStmt;
  result.maybeEmpty = s.if_not_exists === true;
  const skip = new Set<object>([query]);
  if (into.rel) {
    resolver.visited.add(into.rel);
    skip.add(into.rel);
  }
  resolver.ddlSubtree(s, skip);
}

function alterTable(s: AlterTableStmt, resolver: Resolver): void {
  // classify() has already refused every subcommand outside the allowlist.
  resolver.ddlRelation(s.relation, "write");
  resolver.ddlSubtree(s, new Set(s.relation ? [s.relation] : []));
}

function dropTables(s: DropStmt, resolver: Resolver): void {
  for (const obj of s.objects ?? []) {
    if (!("List" in obj)) throw unsupported("a malformed DROP");
    const parts = stringsOf(obj.List.items);
    if (!parts || parts.length === 0 || parts.length > 2) {
      throw unsupported("a malformed or database-qualified DROP target");
    }
    const rv: RangeVar =
      parts.length === 2
        ? { schemaname: parts[0], relname: parts[1] }
        : { relname: parts[0] };
    resolver.ddlRelation(rv, "write");
  }
  resolver.ddlSubtree(s);
}
