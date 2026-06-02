// Postgres metadata SQL — the canned queries the list_tables / describe_table
// tools run for schema discovery. Relocated verbatim from the mcp-server tool
// handlers so the SQL is owned by the dialect: the tools no longer hardcode a
// Postgres-shaped query, they ask `dialect.listTablesSql(...)` (reached through
// the registry's EngineEntry, since Engine.dialect is private). Both queries
// hit the SQL-standard information_schema, which Postgres and MySQL share — so
// the MySQL dialect re-exports these unchanged.
//
// SECURITY: `schema` / `table` are embedded as string literals. Callers MUST
// pass identifier-validated values — the tool handlers enforce a strict
// `^[a-zA-Z_][a-zA-Z0-9_]*$` regex before these are ever called. The values
// never originate from agent SQL; they come from the tool's structured args.
// These queries still flow through engine.handle() (parsed, policy-checked,
// audited); information_schema is carved out of table_access + tenant_scope so
// discovery works under default-deny.

export function listTablesSql(schema: string): string {
  return (
    `SELECT table_schema, table_name FROM information_schema.tables ` +
    `WHERE table_schema = '${schema}' ORDER BY table_name`
  );
}

export function describeTableSql(schema: string, table: string): string {
  return (
    `SELECT column_name, data_type, is_nullable, column_default ` +
    `FROM information_schema.columns ` +
    `WHERE table_schema = '${schema}' AND table_name = '${table}' ` +
    `ORDER BY ordinal_position`
  );
}
