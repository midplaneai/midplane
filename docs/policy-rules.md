# Policy rules

OSS Midplane ships four policy rules. The `table_access` rule is YAML-
driven; the rest are hardcoded. Approvals (Slack-bot, web queue,
escalation) are a Cloud feature, not OSS.

## `table_access` (default: ON)

Per-table read/write policy. Each referenced table resolves to one of:

- `deny` — neither read nor write
- `read` — SELECT allowed; any write denied
- `read_write` — both allowed

A query is denied if **any** referenced table fails its required
permission. Reads must satisfy `read` or `read_write`; writes must
satisfy `read_write`. The walk is AST-recursive — writes hidden in
CTEs / subqueries / UNION arms / JOINs are detected at the inner
write node and checked against that target's permission.

Out of the box (no YAML), the rule's default is deny-all-writes:
every SELECT allows, every write denies. To grant per-table writes,
mount a YAML policy file via `MIDPLANE_POLICY_FILE`:

```yaml
table_access:
  default: read           # default for tables not listed below
  tables:
    users:            read
    posts:            read
    audit_log:        deny
    webhooks:         read_write
    feature_flags:    read_write
    "stripe.charges": read    # schema-qualified key, matched first
```

Schema resolution: a schema-qualified key (`stripe.charges`) is matched
first; bare names (`users`) match anything not schema-qualified, and
also match schema-qualified references (`public.users`) when no
qualified key exists. `default: deny` blocks reads and writes on
every unlisted table.

Examples:

```sql
-- with the YAML above:
SELECT * FROM users                                          -- ALLOW (read)
DELETE FROM users WHERE id = 1                               -- DENY  (users is read)
INSERT INTO feature_flags (name) VALUES ('beta')             -- ALLOW (feature_flags is read_write)
WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x    -- DENY  (recursive catch on inner DELETE)
INSERT INTO webhooks (msg) SELECT msg FROM audit_log         -- DENY  (audit_log read denies)
SELECT * FROM audit_log                                      -- DENY  (deny)

-- with no YAML (legacy default):
DELETE FROM anywhere                                         -- DENY  (no table is read_write)
SELECT * FROM anywhere                                       -- ALLOW (default = read)
```

> **Approvals don't ship in OSS.** OSS denial returns a structured MCP
> error; the agent reads the reason and pivots. Slack-bot / web-queue
> approval workflows are a Midplane Cloud feature on top of the same
> engine — same policy YAML, plus humans in the loop.

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

Self-host config (YAML; lives in the same `MIDPLANE_POLICY_FILE` as
`table_access`):

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

## What isn't a policy rule (OSS)

- "Approval flow" — humans-in-the-loop approvals are a Midplane Cloud feature; OSS Midplane is policy-as-YAML only.
- "Limit row count" — `LIMIT` clause not enforced. Long-term roadmap.
- "Match against a SQL pattern" — explicitly rejected. Regex-on-SQL is the anti-pattern Midplane fights.
- "Approve based on time-of-day / business hours" — later roadmap.
- "Prevent specific column reads" — later roadmap (fine-grained schema-aware policy).
