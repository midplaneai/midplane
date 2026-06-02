// MySQL metadata SQL for list_tables / describe_table.
//
// MySQL ships the SQL-standard information_schema, so these queries are
// byte-identical to the Postgres dialect's — re-exported rather than copied so
// the two never drift. (MySQL conflates schema and database: `table_schema` is
// the database name, so a MySQL caller passes its database name as the `schema`
// arg. The discovery carve-out + identifier-regex contract are identical.)
//
// This is intentionally NOT a parser-AST file: it only emits SQL strings, so it
// doesn't count against the "one MySQL file names the parser AST" rule.

export { listTablesSql, describeTableSql } from "../postgres/metadata.ts";
