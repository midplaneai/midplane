# Policy rules

Midplane ships five policy rules. The `table_access` and `guardrails` rules are
YAML-driven; the rest are hardcoded. Two further YAML sections — `column_masks`
and `approvals` — aren't rules: they shape or hold a statement the rules have
already allowed. Both are documented at the end.

Evaluation order (first DENY wins): `parse_error` → `multi_statement` →
`table_access` → `tenant_scope` → `dangerous_statement`. The guardrails run
**last**, so when a more-specific rule would also deny, that rule's reason
surfaces; `dangerous_statement` only adds new denials for statements every
other rule permitted. Masking and approvals run after all of them, on the
ALLOW path only.

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

Schema resolution mirrors how Postgres's default search_path
(`"$user", public`) resolves bare names. Lookup order:

1. Schema-qualified ref (`FROM stripe.charges`) → try `stripe.charges` key.
2. Bare ref (`FROM users`) → try `public.<name>` (`public.users`) before
   the bare key, so policies in canonical schema-qualified form match
   agent SQL that uses bare names.
3. Bare key (`users`) — matches bare refs and any schema-qualified ref
   whose qualified key is absent from policy.
4. Otherwise `default`.

`default: deny` blocks reads and writes on every unlisted table.

The bare → `public.<name>` fallback assumes Postgres actually resolves
bare refs to `public`. To make this a hard guarantee instead of a guess,
`PgPoolExecutor` pins every connection's search_path to `public,
pg_catalog` via the libpq `options` startup parameter, and `SET`
(`VariableSetStmt`) is denied unconditionally so agent SQL can't
rewrite search_path on a pooled connection. Tables outside `public`
must be referenced with schema-qualified names in both policy and SQL
(`FROM app_data.users` + `app_data.users: read`); bare refs always
resolve to `public`.

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

> **A denial is final.** It returns a structured MCP error; the agent reads
> the reason and pivots. `approvals` (below) is not an escape hatch from
> this — it holds writes the policy has already **allowed**, so nothing a
> rule denied can be approved into running.

## `multi_statement` (default: ON)

Denies any query whose AST contains more than one top-level statement. Catches the Datadog Security Labs SQLi vector against the deprecated Anthropic Postgres MCP.

```sql
SELECT 1                                                   -- ALLOW (1 statement)
SELECT 1;                                                  -- ALLOW (trailing semicolon, 1 statement)
SELECT 1; DROP TABLE users;                                -- DENY (2 statements)
```

## `tenant_scope` (default: OFF; opt-in per customer)

Denies queries on tenant-scoped tables that lack a literal `WHERE {column} = {context.tenant_id}` predicate at the same scope.

Conservative semantics: subqueries, CTEs, UNION arms, JOINs, and function calls all enforced. Some legitimate queries may be denied (false positives possible; we'll keep refining the matcher).

### Strict mode (0.5.0+, recommended)

Set a universal `column` and every queried table is tenant-scoped unless you say otherwise. The dangerous path — a forgotten table that silently leaks — is named (`exempt`), not the default.

```yaml
tenant_scope:
  enabled: true
  column: tenant_id        # universal tenant column
  overrides:               # tables that use a different column
    orders: org_id
  exempt:                  # tables that intentionally don't filter
    - audit_log
    - regions
```

Lookup order per queried table:

1. `exempt[table]` ⇒ table is not scoped. Most explicit signal wins.
2. `overrides[table]` ⇒ table is scoped on the override column.
3. `column` ⇒ table is scoped on the universal column.

If none match (no `exempt`, no override, and `column` is unset), the table isn't checked — that's the legacy `mappings`-only behavior below.

> The engine does **no schema introspection**. The rule's job is to check that the AST carries `WHERE <column> = <tenant_id>` at every scope where a scoped table appears. If your agent issues `WHERE tenant_id = 42` against a table without a `tenant_id` column, Postgres surfaces the column-missing error — the operator's cue to mark that table `exempt` or add an `overrides` entry.

> `information_schema` is **always exempt** — the canned `list_tables` and `describe_table` tools need it under strict mode, same as the existing `table_access` carve-out. `pg_catalog` is not exempt; if your agent needs to read it, list specific tables under `exempt`.

### DML semantics

`tenant_scope` checks writes the same way it checks reads, plus an additional rule for `INSERT`:

| Statement | What's checked |
|---|---|
| `SELECT` | Every scoped table in `FROM`/joins/subqueries/CTEs/UNION arms needs the predicate at its own scope. |
| `UPDATE` / `DELETE` | The target table (and any `FROM`/`USING` join tables) need the predicate in the `WHERE` clause. `UPDATE t SET ... WHERE t.tenant_col = <ctx>` allows; bare `UPDATE t SET ...` denies. |
| `INSERT … VALUES` | The column list must explicitly include the tenant column, and every row's literal at that position must equal `ctx.tenant_id`. `INSERT INTO t (tenant_id, ...) VALUES (42, ...)` allows; omitting the column, omitting the value, or wrong-tenant literal denies. |
| `INSERT … SELECT` | Conservative deny on the scoped target — the inserted rows depend on the SELECT's output, which we can't statically verify column-by-column. |
| `INSERT … ON CONFLICT DO UPDATE` | Conservative deny — the update path can rewrite rows that don't match the VALUES check. `ON CONFLICT DO NOTHING` is fine. |
| `MERGE` | Conservative deny on the scoped target. Operators who need MERGE must list the table under `exempt`. |

### Legacy mode (`mappings`, pre-0.5.0)

```yaml
tenant_scope:
  enabled: true
  mappings:                # alias for `overrides`; deprecated
    users:    org_id
    posts:    org_id
    invoices: customer_id
```

Without `column` set, only tables listed in `mappings` (alias for `overrides`) are checked. **Tables you forget to list are not scoped** — this is the footgun strict mode closes. Existing 0.4.x configs continue to work; the alias is accepted and will be removed in a later release.

`mappings` and `overrides` in the same document are rejected — `mappings` is the pre-0.5.0 alias for `overrides`, so picking both is a configuration bug.

### Migration

Adding a `column:` to an existing config will likely deny some queries that worked before — anywhere an agent touched a table that was previously unlisted. That's the point: those queries were unscoped. Expect a one-time pass to:

- Add genuinely tenant-free tables to `exempt` (audit logs, region/lookup tables).
- Add tables that use a non-default column to `overrides`.
- Update agent SQL to include the predicate everywhere else.

Per-session: set `MIDPLANE_TENANT_ID=42` in env vars. Hosted: `tenant_id` claim on the issued MCP token.

## `dangerous_statement` (default: ON)

The "an agent can't nuke prod" net. Blocks categorically-destructive
operations **regardless of `table_access` / `tenant_scope`** — so marking a
table `read_write` to allow legitimate writes does *not* thereby permit a
whole-table wipe or a schema change. Two independently-toggled guards, **both
on by default** (a self-host deployment is protected without writing any YAML):

```yaml
guardrails:
  block_unqualified_dml: true   # deny DELETE/UPDATE with no WHERE clause
  block_ddl: true               # deny DROP / TRUNCATE / ALTER
```

- **`block_unqualified_dml`** — denies a `DELETE` or `UPDATE` with no `WHERE`
  clause (the whole-table write). Detected at every `DELETE`/`UPDATE` node,
  including ones hidden in a data-modifying CTE (`WITH d AS (DELETE FROM t
  RETURNING *) …` is caught — it wipes the table just the same). Presence of
  *any* `WHERE` (even `WHERE true`) makes it "qualified" — this guard is the
  missing-`WHERE` footgun specifically, not a predicate-strength check (that's
  `tenant_scope`'s job).
- **`block_ddl`** — denies `DROP`, `TRUNCATE`, and the **whole `ALTER`
  family** — every `ALTER …` form, including ones libpg_query models as their
  own node kind (`ALTER … RENAME`, `ALTER TYPE … ADD VALUE`, `ALTER ROLE`,
  `ALTER … SET SCHEMA`, …), not just `ALTER TABLE`. `CREATE` is **not** blocked
  in v1. (`table_access` independently classifies the same ALTER forms as
  writes/side-effects, so disabling `block_ddl` still leaves an `ALTER` on a
  non-`read_write` table denied.)

The whole `guardrails:` section defaults ON when omitted, and each flag
independently defaults `true` when the section is present — so
`guardrails: { block_ddl: false }` keeps unqualified-DML blocking on while
allowing DDL. Set a flag to `false` to opt out.

```sql
-- with a policy that marks `orders: read_write` and no guardrails block:
DELETE FROM orders                       -- DENY  (no WHERE → whole-table wipe)
DELETE FROM orders WHERE id = 1          -- ALLOW (scoped to specific rows)
UPDATE orders SET shipped = true         -- DENY  (no WHERE)
DROP TABLE orders                        -- DENY  (DDL)
TRUNCATE orders                          -- DENY  (DDL)
ALTER TABLE orders ADD COLUMN x int      -- DENY  (DDL)
```

Because the guardrails run last, a destructive statement on a table that
`table_access` *already* denies (e.g. a `DROP` under the no-YAML
deny-all-writes default) surfaces the `table_access` reason — it's blocked
either way. Hot-swappable via `POST /admin/policy` like the other sections;
omitting `guardrails` from a swap body leaves the current posture untouched.

## `parse_error` (default: ON, implicit)

Denies any input that fails to parse. `libpg_query` is the parser. Anything that looks like a string but isn't valid Postgres SQL is denied.

## `column_masks` (default: OFF)

Not a deny rule — a rewrite. Naming a column here never changes *whether* a
query is allowed, only what comes back. A masked column must still be readable;
`table_access` decides that independently, and masking presupposes the read.

```yaml
column_masks:
  "public.users":
    email:       full-redact
    ssn:         { t: partial, keepEnd: 4 }
    signup_at:   { t: generalize, granularity: month }
    customer_id: consistent-hash
mask_source_rewrite: true
requires_features: [column_masks, mask_source_rewrite]
```

Transforms: `full-redact` (→ `***`), `null-out` (SQL `NULL` keeping the
column's declared type, so non-text PII masks without changing the wire type),
`consistent-hash` (deterministic and salted — masked join keys still join),
`partial` (`keepStart` / `keepEnd` / `glyph`), `generalize` (`year` | `month` |
`day`, or a numeric bucket), `pseudonymize` (`kind`, from the dictionaries the
engine ships), and `noise` (`ratio` in `(0, 1]`).

**Salt required.** Deterministic transforms are keyed by `MIDPLANE_MASK_SALT`.
The engine refuses to boot with masks and no salt rather than fall back to an
unsalted — and therefore correlatable — hash.

**Where the masking happens.** With `mask_source_rewrite: true` the engine
rewrites the query's source relation, so the mask is applied *inside* the
statement: joins, filters, and aggregates see masked values instead of raw
ones. With it off, the post-execution masker transforms the result set on the
way out, and can only prove provenance for plain column references — so any
computed output (an aggregate included, even over an unmasked table) is
rejected for that whole database. Source rewriting is what lets
`SELECT count(*) …` coexist with masking, and the control plane turns it on for
every database that declares masks. `MIDPLANE_MASK_SOURCE_REWRITE` sets the
engine-wide default; the per-DB YAML key overrides it.

**Fails closed either way.** Provenance the engine can't prove maps back to a
known base column — views, computed expressions, whole-row serialization, a
stale catalog — denies the whole result set rather than risk emitting an
unmasked value. Under source rewrite, the same posture covers functions: every
function a masked statement invokes must be a vetted mask-safe builtin, so a
call that reads a masked table through a string the parser can't see
(`query_to_xml`, `dblink`, an FDW, a `SECURITY DEFINER` UDF) is denied instead
of returning raw PII. `information_schema` / `pg_catalog` are exempt (no
maskable customer row values), mirroring the `table_access` / `tenant_scope`
carve-outs.

## `approvals` (default: OFF)

Not a deny rule either — a hold. The stage runs only **after** the rules above
have returned ALLOW, so approvals sit under the policy, never over it: there is
no path from denied to approved.

```yaml
approvals:
  writes: true                # the umbrella — hold every write class
  # or per class (then declare requires_features: [write_rules]):
  # row_changes:        true  # INSERT / UPDATE / DELETE with a WHERE
  # whole_table_writes: true  # unqualified DELETE / UPDATE
  # schema_changes:     false # DDL
```

Any class key present overrides the umbrella for that class. The umbrella alone
needs no feature token; a policy that holds only *some* classes must declare
`requires_features: [write_rules]`, because an engine predating the split would
strip the class keys and resolve to holding nothing.

**A gate is required.** The engine decides *whether* to ask; the control plane
decides the answer. Wire `MIDPLANE_APPROVAL_URL` + `MIDPLANE_APPROVAL_TOKEN`
(the app serves the gate, cloud or self-hosted). With approvals on and no gate
the server refuses to boot, rather than hold every write against something that
will never answer.

**What the agent sees.** A held write returns as pending, with an id and an
expiry, and the agent is offered a `check_approval` tool to collect the ruling.
The grant is bound to that exact statement and consumed when it runs, so
re-running asks again instead of silently repeating the write. A denial carries
the reviewer's note back to the agent — "use the refunds table instead" is worth
far more than a bare refusal.

Deliberately no row-count estimate. An earlier design routed on `EXPLAIN` row
counts and needed a post-execution guard to contain an estimator that errs low
by up to 400,000x; holding every write of a class has nothing to estimate.

## What isn't a policy rule

- "Limit row count" — `LIMIT` clause not enforced. Long-term roadmap.
- "Match against a SQL pattern" — explicitly rejected. Regex-on-SQL is the anti-pattern Midplane fights.
- "Approve based on time-of-day / business hours" — later roadmap. `approvals` holds by write class, not by clock.
- "Prevent specific column reads" — later roadmap (fine-grained schema-aware policy). `column_masks` redacts a column's values; it doesn't deny the read.
