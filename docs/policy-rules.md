# Policy rules

Midplane ships four hardcoded policy rules. Custom YAML policy authoring is on the roadmap.

## `writes_require_approval` (default: ON)

Denies any AST node matching the write set: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `TRUNCATE`, `ALTER`, `GRANT`, `REVOKE`, `CREATE`, `EXECUTE`, `CALL`. Recursive — catches writes embedded in CTEs, subqueries, function calls.

There is no in-product approval flow yet; denial returns a structured MCP error. Per-customer opt-in to allow writes is on the roadmap.

Examples:

```sql
DELETE FROM users                                          -- DENY
WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x  -- DENY (recursive catch)
SELECT * FROM users                                        -- ALLOW
```

## `multi_statement` (default: ON)

Denies any query whose AST contains more than one top-level statement. Catches the Datadog Security Labs SQLi vector against the deprecated Anthropic Postgres MCP.

```sql
SELECT 1                                                   -- ALLOW (1 statement)
SELECT 1;                                                  -- ALLOW (trailing semicolon, 1 statement)
SELECT 1; DROP TABLE users;                                -- DENY (2 statements)
```

## `tenant_scope` (default: OFF; opt-in per customer)

Configurable per customer. Maps tables to tenant columns. Denies queries on mapped tables that lack a literal `WHERE {column} = {context.tenant_id}` predicate at the same scope.

Conservative semantics: subqueries, CTEs, UNION arms, JOINs, and function calls all enforced. Some legitimate queries may be denied (false positives possible; we'll keep refining the matcher).

Self-host config (YAML):

```yaml
tenant_scope:
  enabled: true
  mappings:
    users:    org_id
    posts:    org_id
    invoices: customer_id
```

Per-session: set `MIDPLANE_TENANT_ID=42` in env vars. Hosted: `tenant_id` claim on the issued MCP token.

## `parse_error` (default: ON, implicit)

Denies any input that fails to parse. `libpg_query` is the parser. Anything that looks like a string but isn't valid Postgres SQL is denied.

## What isn't a policy rule (today)

- "Limit row count" — `LIMIT` clause not enforced. Long-term roadmap.
- "Match against a SQL pattern" — explicitly rejected. Regex-on-SQL is the anti-pattern Midplane fights.
- "Approve based on time-of-day / business hours" — later roadmap.
- "Prevent specific column reads" — later roadmap (fine-grained schema-aware policy).
