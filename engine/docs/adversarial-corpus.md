# Adversarial SQL corpus

Every shape in this document is a real test in
[`packages/engine/test/adversarial/`](../packages/engine/test/adversarial).
The corpus exists to answer one question: *what does Midplane actually
catch, and where are its limits?* It is intentionally short on marketing
and long on SQL.

OSS Midplane ships four policy rules, in this evaluation order:

1. `parse_error` — input couldn't be parsed
2. `multi_statement` — input parsed to more than one top-level statement
3. `table_access` — per-table R/W policy. With no YAML: every write
   denies (every SELECT allows). With YAML: each referenced table must
   satisfy its required permission (`read` for read-position tables,
   `read_write` for write targets); recursive over CTEs, subqueries,
   UNION arms, JOINs.
4. `tenant_scope_missing` — opt-in. With a `users → org_id` mapping and
   `tenant_id=42`, every read of a mapped table needs a literal
   `WHERE org_id = 42` predicate at the same SelectStmt scope, reachable
   through `AND` only

The corpus is **conservative by default**: when in doubt we deny.
False positives (legitimate queries refused) are bugs we triage as we go.
Bypasses are release blockers.

---

## 1. table_access (per-table R/W, recursive AST detection)

With no YAML config, every write denies (no table is `read_write`).
With YAML, write targets need `read_write`; read-position tables need
`read` or `read_write`. The recursive walker checks every node — top-
level, inside a CTE, inside a subquery, inside a UNION arm, inside a
JOIN.

| SQL                                                                         | Verdict | Rule                       | Why this matters |
|-----------------------------------------------------------------------------|---------|----------------------------|------------------|
| `DELETE FROM users`                                                         | DENY    | `table_access`  | Unbounded delete (PocketOS-style); read-only by default. |
| `DELETE FROM users WHERE id = 1`                                            | DENY    | `table_access`  | Bounded delete still denies — Midplane does not infer "scoped enough". |
| `UPDATE users SET name='b' WHERE org_id=42`                                 | DENY    | `table_access`  | Even with a tenant predicate, an UPDATE is a write. |
| `UPDATE a SET n=1 FROM b WHERE a.id=b.id`                                   | DENY    | `table_access`  | Multi-table UPDATE form. |
| `INSERT INTO users (org_id, name) VALUES (42, 'a')`                         | DENY    | `table_access`  | Plain INSERT. |
| `INSERT INTO logs (msg) VALUES ('x') RETURNING id, msg`                     | DENY    | `table_access`  | RETURNING does not change classification — still a write. |
| `INSERT INTO t (x) VALUES (1) ON CONFLICT (x) DO NOTHING`                   | DENY    | `table_access`  | UPSERT idempotency does not exempt the write. |
| `INSERT INTO t (x,y) VALUES (1,2) ON CONFLICT (x) DO UPDATE SET y = excluded.y` | DENY | `table_access` | UPSERT with conflict-update branch. |
| `MERGE INTO target … WHEN MATCHED … WHEN NOT MATCHED …`                     | DENY    | `table_access`  | MERGE is a write regardless of which arm fires. |
| `DROP TABLE x`                                                              | DENY    | `table_access`  | DDL. |
| `TRUNCATE t`                                                                | DENY    | `table_access`  | DDL. |
| `CREATE TABLE foo (id int)`                                                 | DENY    | `table_access`  | DDL. |
| `CREATE TABLE foo AS SELECT * FROM users`                                   | DENY    | `table_access`  | CTAS — write in disguise. |
| `ALTER TABLE users ADD COLUMN flag boolean`                                 | DENY    | `table_access`  | DDL. |
| `CREATE INDEX idx_users_email ON users (email)`                             | DENY    | `table_access`  | DDL. |
| `CREATE VIEW v AS SELECT 1`                                                 | DENY    | `table_access`  | DDL. |
| `REFRESH MATERIALIZED VIEW v`                                               | DENY    | `table_access`  | Materialized-view rebuild. |
| `GRANT SELECT ON users TO some_role`                                        | DENY    | `table_access`  | DCL. |
| `REVOKE SELECT ON users FROM some_role`                                     | DENY    | `table_access`  | DCL. |
| `GRANT admin TO some_user`                                                  | DENY    | `table_access`  | Role membership. |
| `CREATE SCHEMA s`                                                           | DENY    | `table_access`  | DDL. |
| `CREATE ROLE bob`                                                           | DENY    | `table_access`  | DDL. |
| `CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql`            | DENY    | `table_access`  | DDL. |
| `CREATE DATABASE d`                                                         | DENY    | `table_access`  | DDL. |
| `ALTER DOMAIN d SET DEFAULT 1`                                              | DENY    | `table_access`  | DDL. |
| `CREATE RULE r AS ON SELECT TO t DO INSTEAD SELECT 1`                       | DENY    | `table_access`  | DDL. |

### Hidden inside a CTE

This category is the canonical recursive-detection case. Codex flagged it
during eng review; the walker exists to close it.

| SQL                                                                                           | Verdict | Rule                       |
|-----------------------------------------------------------------------------------------------|---------|----------------------------|
| `WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x`                                       | DENY    | `table_access`  |
| `WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x`                                    | DENY    | `table_access`  |
| `WITH x AS (INSERT INTO y (n) VALUES (1) RETURNING *) SELECT * FROM x`                        | DENY    | `table_access`  |
| `WITH a AS (SELECT 1), b AS (DELETE FROM y RETURNING n) SELECT * FROM a, b`                   | DENY    | `table_access`  |
| `WITH outer AS (WITH inner AS (DELETE …) SELECT … FROM inner) SELECT * FROM outer`            | DENY    | `table_access`  |
| `WITH d AS (DELETE FROM y RETURNING id) INSERT INTO archive (id) SELECT id FROM d`            | DENY    | `table_access`  |
| `WITH RECURSIVE r AS (…), w AS (DELETE FROM y RETURNING id) SELECT * FROM r, w`               | DENY    | `table_access`  |
| `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x WHERE EXISTS (SELECT 1 FROM d …)`    | DENY    | `table_access`  |

### Hidden inside set-ops

UNION / INTERSECT / EXCEPT arms are visited as virtual SelectStmt scopes
by the walker — writes hidden in any arm via a CTE still trip the rule.

| SQL                                                                          | Verdict | Rule                       |
|------------------------------------------------------------------------------|---------|----------------------------|
| `WITH d AS (DELETE … RETURNING id) SELECT … FROM x UNION SELECT id FROM d`   | DENY    | `table_access`  |
| `WITH d AS (DELETE … RETURNING id) … INTERSECT SELECT id FROM d`             | DENY    | `table_access`  |
| `WITH d AS (DELETE … RETURNING id) … EXCEPT SELECT id FROM d`                | DENY    | `table_access`  |

### Opaque procedural body (DO blocks)

`libpg_query` keeps the `DO $$ … $$` body as an opaque string literal.
We can't see inside, so we deny outright — even read-only bodies. This
is conservative-by-default in action.

| SQL                                              | Verdict | Rule                       |
|--------------------------------------------------|---------|----------------------------|
| `DO $$ BEGIN DELETE FROM users; END $$`          | DENY    | `table_access`  |
| `DO $$ BEGIN PERFORM 1; END $$`                  | DENY    | `table_access`  |
| `DO $tag$ BEGIN PERFORM 1; END $tag$`            | DENY    | `table_access`  |

### Per-table R/W under YAML

The cases below assume a `MIDPLANE_POLICY_FILE` of:

```yaml
table_access:
  default: read
  tables:
    users:            read
    posts:            read
    audit_log:        deny
    webhooks:         read_write
    feature_flags:    read_write
    "stripe.charges": read
```

| SQL                                                                  | Verdict | Why                                  |
|----------------------------------------------------------------------|---------|--------------------------------------|
| `SELECT * FROM users WHERE id = 1`                                   | ALLOW   | `users` is `read`                    |
| `DELETE FROM users WHERE id = 1`                                     | DENY    | `users` is `read`, not `read_write`  |
| `DELETE FROM webhooks WHERE id = 1`                                  | ALLOW   | `webhooks` is `read_write`           |
| `INSERT INTO feature_flags (name) VALUES ('beta')`                   | ALLOW   | `feature_flags` is `read_write`      |
| `SELECT * FROM audit_log`                                            | DENY    | `audit_log` is `deny` (no read either) |
| `WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x`          | DENY    | inner DELETE on `read` table         |
| `WITH x AS (DELETE FROM webhooks RETURNING *) SELECT * FROM x`       | ALLOW   | inner DELETE on `read_write` table   |
| `INSERT INTO webhooks (msg) SELECT msg FROM audit_log`               | DENY    | read side hits `deny` table          |
| `INSERT INTO webhooks (uid) SELECT id FROM users`                    | ALLOW   | write target `read_write`, read side `read` |
| `SELECT * FROM stripe.charges`                                       | ALLOW   | schema-qualified key resolves to `read` |
| `DELETE FROM stripe.charges`                                         | DENY    | schema-qualified key is `read`       |
| `INSERT INTO unlisted (n) VALUES (1)` (with default `read`)          | DENY    | unlisted falls through to default `read` |
| `SELECT * FROM unlisted` (with default `read`)                       | ALLOW   | default `read` permits SELECT        |
| `SELECT * FROM something` (with default `deny`)                      | DENY    | default `deny` blocks reads of unlisted |
| `WITH x AS (SELECT 1) SELECT * FROM x` (with default `deny`)         | ALLOW   | `x` is a CTE, not a table reference |
| `WITH audit_log AS (SELECT 1) SELECT * FROM audit_log`               | ALLOW   | CTE name shadows the `deny` table; the real `audit_log` is never touched |
| `WITH audit_log AS (SELECT 1) SELECT * FROM public.audit_log`        | DENY    | schema-qualified ref bypasses CTE shadowing; resolves to `audit_log: deny` |
| `COPY webhooks TO '/tmp/leak'` (with `webhooks: read_write`)         | DENY    | `COPY` has side effects beyond row writes; YAML can't grant it |
| `LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE` (with `webhooks: read_write`) | DENY | `LOCK` has concurrency side effects; YAML can't grant it |

### Legacy parity (no YAML)

Behavior identical to the previous `writes_require_approval` rule.

| SQL                                                | Verdict | Rule           |
|----------------------------------------------------|---------|----------------|
| `DELETE FROM anywhere`                             | DENY    | `table_access` |
| `INSERT INTO anywhere VALUES (1)`                  | DENY    | `table_access` |
| `SELECT * FROM anywhere`                           | ALLOW   | (default read) |

---

## 2. multi_statement (stacked-statement injection)

We count `tree.stmts.length`, not raw semicolons. The Postgres parser
strips comments and resolves quoted strings before counting, so the
classic injection vectors don't fool the rule.

Real-world precedent: [Datadog Security Labs's stacked-statement SQLi
disclosure](https://www.datadoghq.com/blog/engineering/) against the
deprecated Anthropic Postgres MCP — `SELECT 1; DROP TABLE users`.

| SQL                                          | Verdict | Rule              | Note |
|----------------------------------------------|---------|-------------------|------|
| `SELECT 1; DROP TABLE users;`                | DENY    | `multi_statement` | Canonical Datadog vector. |
| `SELECT 1; SELECT 2; SELECT 3`               | DENY    | `multi_statement` | Three statements. |
| `UPDATE x SET n=1; SELECT 1`                 | DENY    | `multi_statement` | Multi fires before writes (rule order). |
| `CREATE TABLE x (id int); DROP TABLE x;`     | DENY    | `multi_statement` | Stacked DDL. |
| `SELECT 1; GRANT SELECT ON users TO …`       | DENY    | `multi_statement` | Stacked DCL. |
| `SELECT 1; COPY users TO '/tmp/leak'`        | DENY    | `multi_statement` | Stacked exfiltration. |
| `BEGIN; UPDATE … SET …; COMMIT`              | DENY    | `multi_statement` | Stacked transaction-wrapped write. |

### Comments do NOT inflate the count

| SQL                                          | Verdict | Note |
|----------------------------------------------|---------|------|
| `SELECT 1; -- ; DROP TABLE x;`               | ALLOW   | Line comment hides everything after `--`. |
| `/* ; SELECT 99; */ SELECT 1`                | ALLOW   | Block comment is text, not a statement. |
| `-- ; ; ;\nSELECT 1`                         | ALLOW   | Comment-only line, then one real statement. |
| `/* DROP TABLE x; */ SELECT 1`               | ALLOW   | Block comment is text. |
| `SELECT 1; /* benign */ SELECT 2`            | DENY    | Two real statements + a comment between them. |

### Semicolons inside string literals do NOT inflate the count

| SQL                                              | Verdict | Note |
|--------------------------------------------------|---------|------|
| `SELECT 'a;b'`                                   | ALLOW   | Single-quoted string. |
| `SELECT 'a; DROP TABLE x; --b'`                  | ALLOW   | Stacked-injection-shaped string is still one literal. |
| `SELECT E'a\\'; b'`                              | ALLOW   | Escape-string with embedded `;`. |
| `SELECT $$multi; line; here$$`                   | ALLOW   | Dollar-quoted string. |
| `SELECT $tag$x; y; z$tag$`                       | ALLOW   | Tagged dollar-quote. |

### Trailing / empty semicolons

libpg-query collapses runs of trailing/leading empty statements before
counting. The verdicts below are pinned exact in CI so a parser upgrade
that starts counting empties as separate statements (silently flipping
these to `multi_statement`) is caught.

| SQL          | Verdict             |
|--------------|---------------------|
| `SELECT 1;`  | ALLOW (one stmt)    |
| `SELECT 1;;;`| ALLOW (trailing empties collapse) |
| `;SELECT 1`  | ALLOW (leading empty collapses)   |
| `;`          | `parse_error` (no real statements) |
| `;;;`        | `parse_error` (no real statements) |

---

## 3. tenant_scope (cross-tenant exfiltration)

Opt-in. Each queried table resolves to either "scoped on column X" or
"not scoped" per the YAML config (see [policy-rules.md](./policy-rules.md#tenant_scope-default-off-opt-in-per-customer)).
A scoped table needs a literal `WHERE <column> = <context.tenant_id>`
reachable through `AND` conjunctions, at the **same SelectStmt scope**
as the table reference. UNION arms, CTE bodies, and subqueries each
get their own scope check.

In strict mode (0.5.0, `column: tenant_id` set at the top level), every
queried table is scoped unless `exempt` lists it. In legacy mode
(`mappings`-only), only listed tables are scoped — tables you forget
to list are silently unscoped (the footgun strict mode closes).

Real-world precedent: cross-tenant exfiltration via missing or
wrong-literal WHERE has been the dominant Postgres-MCP-class bug
shape (Supabase, generic-MCP wrappers, etc.).

### Missing / wrong scope

| SQL                                                | Verdict | Rule                     |
|----------------------------------------------------|---------|--------------------------|
| `SELECT * FROM users`                              | DENY    | `tenant_scope_missing`   |
| `SELECT * FROM users WHERE id > 0`                 | DENY    | `tenant_scope_missing`   |
| `SELECT * FROM users WHERE org_id = 42`            | ALLOW   | (matches context)        |
| `SELECT version()`                                 | ALLOW   | non-mapped table        |
| `SELECT * FROM users` *(tenant_scope OFF)*         | ALLOW   | rule not enabled         |

### Wrong-literal predicates (the "fake safety" class)

| SQL                                                          | Verdict | Why it bypasses |
|--------------------------------------------------------------|---------|-----------------|
| `SELECT * FROM users WHERE org_id = 99`                      | DENY    | Wrong literal — different tenant. |
| `SELECT * FROM users WHERE 1 = 1`                            | DENY    | Tautology, no scope. |
| `SELECT * FROM users WHERE id IS NOT NULL`                   | DENY    | Looks broad but doesn't pin tenant. |
| `SELECT * FROM users WHERE true`                             | DENY    | Same shape. |
| `SELECT * FROM users WHERE org_id IN (42)`                   | DENY    | Conservative: operator must be `=`, not `IN`. |
| `SELECT * FROM users WHERE org_id::text = '42'`              | DENY    | Conservative: cast fails the literal extractor. |
| `SELECT * FROM users WHERE org_id = NULL`                    | DENY    | NULL literal isn't a value the literal extractor recognizes; predicate doesn't match. |

### Predicate connective handling

`AND` propagates; `OR` and `NOT` do not.

| SQL                                                                           | Verdict |
|-------------------------------------------------------------------------------|---------|
| `SELECT * FROM users WHERE foo=1 AND org_id=42`                               | ALLOW   |
| `SELECT * FROM users WHERE (a=1 AND b=2) AND org_id=42`                       | ALLOW   |
| `SELECT * FROM users WHERE org_id=42 OR id>0`                                 | DENY    |
| `SELECT * FROM users WHERE NOT (org_id <> 42)`                                | DENY (logically equivalent but conservative) |
| `SELECT * FROM users WHERE 42 = org_id`                                       | ALLOW   |

### Scope-bypass via nesting

Each SELECT scope is checked independently — including UNION/INTERSECT/EXCEPT
arms, CTE bodies, FROM-clause subselects, and scalar subqueries.

| SQL                                                                             | Verdict |
|---------------------------------------------------------------------------------|---------|
| `SELECT * FROM users WHERE org_id=42 UNION SELECT * FROM users`                 | DENY    |
| `SELECT id FROM users WHERE org_id=42 UNION SELECT id FROM users WHERE org_id=42` | ALLOW |
| `SELECT id FROM users WHERE org_id=42 INTERSECT SELECT id FROM users`           | DENY    |
| `SELECT id FROM users WHERE org_id=42 EXCEPT SELECT id FROM users`              | DENY    |
| `SELECT * FROM (SELECT * FROM users) AS u WHERE u.org_id=42`                    | DENY (inner scope unscoped) |
| `WITH u AS (SELECT * FROM users) SELECT * FROM u`                               | DENY    |
| `WITH u AS (SELECT * FROM users WHERE org_id=42) SELECT * FROM u`               | ALLOW   |
| `SELECT (SELECT count(*) FROM users) AS n`                                      | DENY (scalar subquery) |
| `SELECT 1 WHERE EXISTS (SELECT 1 FROM users)`                                   | DENY (EXISTS subquery on mapped) |
| `SELECT * FROM other WHERE id IN (SELECT id FROM users)`                        | DENY (IN-subquery on mapped) |
| `SELECT * FROM other WHERE id = ANY (SELECT id FROM users)`                     | DENY (ANY-subquery on mapped) |
| `SELECT * FROM users NATURAL JOIN posts WHERE u.org_id = 42`                    | DENY (NATURAL JOIN's inferred ON-condition doesn't substitute for a literal scope predicate) |

### Multi-table JOIN qualifier semantics

The reviewer-flagged "fake safety" class. Without per-table qualifier
matching, a single `u.org_id=42` predicate would have appeared to satisfy
*every* mapped table in the SELECT.

| SQL                                                                                        | Verdict |
|--------------------------------------------------------------------------------------------|---------|
| `SELECT * FROM users u JOIN posts p ON true WHERE u.org_id=42`                             | DENY (only `u` is scoped) |
| `SELECT * FROM users u JOIN posts p ON true WHERE u.org_id=42 AND p.org_id=42`             | ALLOW   |
| `SELECT * FROM users JOIN posts ON true WHERE org_id=42`                                   | DENY (ambiguous; multiple mapped tables) |
| `SELECT * FROM users WHERE users.org_id=42`                                                | ALLOW (qualified by relname) |
| `SELECT * FROM users u, LATERAL (SELECT * FROM posts WHERE author_id=u.id) p WHERE u.org_id=42` | DENY (LATERAL inner SELECT unscoped) |
| `SELECT * FROM users u, LATERAL (SELECT * FROM posts WHERE author_id=u.id AND org_id=42) p WHERE u.org_id=42` | ALLOW |

### Standalone DML on mapped tables (writes rule disabled)

Verifies tenant_scope is correct on its own. In production
`table_access` denies writes first (unless the YAML grants
`read_write`); this section exercises the rule in isolation.
Conservative posture: any DML on a mapped table denies regardless of WHERE.

| SQL                                                                  | Verdict |
|----------------------------------------------------------------------|---------|
| `DELETE FROM users WHERE org_id=42`                                  | DENY    |
| `DELETE FROM users WHERE 1=1`                                        | DENY    |
| `INSERT INTO users (org_id, name) VALUES (99, 'a')`                  | DENY (cross-tenant literal) |
| `UPDATE users SET name='b' FROM logs WHERE users.id=logs.user_id`    | DENY    |
| `MERGE INTO users u USING staging s ON u.id=s.id WHEN MATCHED …`     | DENY    |
| `DELETE FROM logs WHERE id=1`                                        | ALLOW (un-mapped target) |
| `WITH u AS (SELECT id FROM users) DELETE FROM logs WHERE id IN (SELECT id FROM u)` | DENY (inner CTE references mapped without scope) |

---

## 4. parse_error (parser-side guardrail)

The parser owns size limits, empty-input rejection, and surfaces
`SqlError` as a clean `DENY` (never an exception). The Postgres-specific
surface area is `libpg_query` 16.7.x.

### Empty / whitespace / size

| SQL                              | Verdict       |
|----------------------------------|---------------|
| `""`                             | `parse_error` |
| `"   \n\t  "`                    | `parse_error` |
| `"-- nothing here"`              | `parse_error` (comment-only is no statements) |
| `"/* nothing */"`                | `parse_error` |
| `"this is not sql"`              | `parse_error` |
| `"SELECT 'unterminated"`         | `parse_error` |
| `"SELECT * FROM"`                | `parse_error` |
| 1 MiB SELECT (just under cap)    | ALLOW         |
| 1 MiB + 1 byte                   | `parse_error` (size cap rejected before parsing) |
| 100 KiB benign SELECT            | ALLOW         |

### Postgres-specific syntax that parses cleanly

| SQL                                                             | Verdict (read-only by default) |
|-----------------------------------------------------------------|------------------------------|
| `INSERT … RETURNING id`                                         | DENY (`table_access`) — parses fine |
| `UPDATE … RETURNING id, msg`                                    | DENY (`table_access`) |
| `INSERT … ON CONFLICT (x) DO NOTHING`                           | DENY (`table_access`) |
| `SELECT data->'x' FROM events WHERE id=1`                       | ALLOW (JSON arrow) |
| `SELECT data->>'name' FROM events`                              | ALLOW (JSON arrow-text) |
| `SELECT * FROM events WHERE meta @> '{"k":1}'::jsonb`           | ALLOW (JSONB containment) |
| `SELECT int4range(1, 10)`                                       | ALLOW (range constructor) |
| `SELECT … WHERE during && tsrange(…)`                           | ALLOW (range overlap operator) |
| `SELECT ARRAY[1,2,3]`                                           | ALLOW |
| `SELECT DISTINCT ON (org_id) …`                                 | ALLOW |
| `SELECT id, row_number() OVER (PARTITION BY …) FROM users`      | ALLOW (window function) |
| `SELECT count(*) FILTER (WHERE id>0) FROM users`                | ALLOW (FILTER aggregate) |
| `SELECT * FROM users u, LATERAL (SELECT 1) AS s`                | ALLOW |

### Identifier corner cases

| SQL                                              | Verdict                                |
|--------------------------------------------------|----------------------------------------|
| `SELECT * FROM "my table"`                       | ALLOW                                  |
| `SELECT * FROM "üsers" WHERE "id"=1`             | ALLOW (unicode identifier)             |
| `SELECT * FROM public.users WHERE id=1`          | ALLOW (schema-qualified)               |

---

## 5. exec-side-effects (beyond DML)

`table_access` denies more than DML. NOTIFY publishes a pubsub event;
LISTEN/UNLISTEN mutate session subscription state; LOCK acquires a
transaction-scoped lock with availability impact; CALL/EXECUTE invoke
stored code; COPY moves data on the server filesystem; SET would
redirect bare-name table resolution on a pooled connection (breaking
the bare → `public.<name>` policy guarantee). None of these carry an
extractable per-table target the YAML can grant `read_write` to, so
all deny under both legacy and any YAML config.

| SQL                                                  | Verdict |
|------------------------------------------------------|---------|
| `CALL my_proc()`                                     | DENY (`table_access`) |
| `EXECUTE my_prepared`                                | DENY (`table_access`) |
| `NOTIFY ch, 'msg'`                                   | DENY (`table_access`) |
| `LISTEN ch`                                          | DENY (`table_access`) |
| `UNLISTEN ch` / `UNLISTEN *`                         | DENY (`table_access`) |
| `LOCK TABLE users IN ACCESS EXCLUSIVE MODE`          | DENY (`table_access`) |
| `LOCK TABLE users`                                   | DENY (`table_access`) |
| `COPY t FROM '/etc/passwd'`                          | DENY (`table_access`) |
| `COPY t TO '/tmp/leak'`                              | DENY (`table_access`) |
| `COPY t FROM STDIN`                                  | DENY (`table_access`) |
| `COPY (SELECT * FROM users) TO '/tmp/dump'`          | DENY (`table_access`) |
| `SET search_path = malicious_schema, public`         | DENY (`table_access`) |
| `SET LOCAL search_path = elsewhere`                  | DENY (`table_access`) |
| `SET timezone = 'UTC'`                               | DENY (`table_access`) |
| `RESET search_path`                                  | DENY (`table_access`) |

`table_access` reaches all of the above because each is its own statement kind.
A function call is not: a `SELECT` that wraps one parses as an ordinary read and
names no table, which is what `dangerous_function` covers (section 7).

---

## 6. dangerous_statement (destructive-op guardrails)

Categorical blocks that fire **regardless of `table_access` / `tenant_scope`**
(the "an agent can't nuke prod" net). Both guards default ON. These cases use a
permissive policy (the target table is `read_write` and unscoped) so the
guardrail is unambiguously the denier — a table marked `read_write` to allow
legitimate writes cannot be turned into a whole-table wipe or a schema change.
Wired last, so a statement a stricter rule already denies surfaces *that* rule's
reason (it's blocked either way).

| SQL                                                       | Verdict | Rule                  | Why this matters |
|-----------------------------------------------------------|---------|-----------------------|------------------|
| `DELETE FROM webhooks`                                    | DENY    | `dangerous_statement` | No `WHERE` → whole-table wipe, even on a `read_write` table. |
| `UPDATE webhooks SET enabled = true`                      | DENY    | `dangerous_statement` | No `WHERE` → every row rewritten. |
| `WITH d AS (DELETE FROM webhooks RETURNING *) SELECT * FROM d` | DENY | `dangerous_statement` | No-`WHERE` DELETE hidden in a CTE is caught (fail-closed on nested DML). |
| `DROP TABLE webhooks`                                     | DENY    | `dangerous_statement` | DDL on a `read_write` table. |
| `TRUNCATE webhooks`                                       | DENY    | `dangerous_statement` | DDL. |
| `ALTER TABLE webhooks ADD COLUMN flag boolean`            | DENY    | `dangerous_statement` | DDL. |
| `ALTER TABLE webhooks RENAME TO hooks`                    | DENY    | `dangerous_statement` | `ALTER … RENAME` (a `RenameStmt`) is covered. |
| `DROP INDEX webhooks_idx`                                 | DENY    | `dangerous_statement` | Non-table DROP variants count too. |
| `DELETE FROM webhooks WHERE id = 1`                       | ALLOW   | —                     | A `WHERE` makes it qualified — the guard is the missing-`WHERE` footgun, not a predicate-strength check. |
| `DELETE FROM webhooks WHERE true`                         | ALLOW   | —                     | An explicit `WHERE` (even a tautology) is not "unqualified" — that distinction is `tenant_scope`'s job, not this guard's. |

`CREATE` is intentionally not blocked in v1. Each guard is independently
toggleable (`guardrails: { block_ddl: false }`); with both off, the cases above
fall through to `table_access` / `tenant_scope`.

---

## 7. dangerous_function (data reach outside the named relations)

Every rule above decides from the tables a statement **names**. A statement can
put its whole payload inside a function *argument* instead, naming nothing.
`dangerous_function` is the denylist for that shape. It is always on and takes
no configuration — there is no legitimate agent-analytics reason to call one of
these. These cases use a permissive policy (`default: read_write`) so the rule
is unambiguously the denier.

| SQL                                                       | Verdict | Why this matters |
|-----------------------------------------------------------|---------|------------------|
| `SELECT query_to_xml('SELECT ssn FROM secrets', f, t, '')` | DENY   | Runs a SQL string. **Core PG, `EXECUTE` to `PUBLIC`** — no privileged role needed, so it reads any table the connected role can see without naming it. A `table_access` and `tenant_scope` bypass. |
| `SELECT table_to_xml('secrets'::regclass, f, t, '')`      | DENY    | Same reach via a `regclass` argument instead of a query string. |
| `SELECT database_to_xml(f, t, '')`                        | DENY    | Every readable table in the database, in one statement. |
| `SELECT schema_to_xml('public', f, t, '')`                | DENY    | Whole-schema variant. |
| `SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)`  | DENY    | Reads another server; also an SSRF primitive. |
| `SELECT pg_read_file('/etc/passwd')`                      | DENY    | Server-side file read. Postgres also denies this to an unprivileged role; refused here so a privileged connection is not a cliff edge. |
| `SELECT lo_export(lo_import('/etc/passwd'), '/tmp/x')`    | DENY    | File read **and** write to an arbitrary path. |
| `SELECT lo_unlink(1)`                                     | DENY    | A write disguised as a SELECT. |
| `SELECT current_setting('midplane.mask_salt')`            | DENY    | GUC read; can target the masking salt. |
| `SELECT pg_terminate_backend(123)`                        | DENY    | Changes server state. |
| `SELECT upper(pg_read_file('/etc/passwd'))`               | DENY    | Nesting does not evade — the inventory walk is fully recursive (the shape that bypassed pg_anon in GHSA-468r-mhwc-vxjc). |
| `SELECT pg_catalog.pg_read_file('/etc/passwd')`           | DENY    | Qualification does not evade — matching is on the bare name. |
| `SELECT PG_READ_FILE('/etc/passwd')`                      | DENY    | Case does not evade. |
| `SELECT setval('users_id_seq', 1)`                        | DENY    | Writes sequence state through a statement every other rule reads as a query. Winding a sequence backwards collides every later `INSERT` on the primary key. Reachable by an app role granted `ALL ON ALL SEQUENCES` (verified live). |
| `SELECT count(*), sum(total) FROM orders`                 | ALLOW   | Ordinary aggregates. The rule is a denylist, not an allowlist, so normal analytics is untouched. |
| `SELECT my_business_helper(total) FROM orders`            | ALLOW   | A user-defined function is not denied by name. |
| `SELECT generate_series(1, 10)`                           | ALLOW   | Set-returning builtins are fine — they reach no data outside their arguments. |
| `SELECT * FROM json_to_record('{"a":1}') AS r(a int)`     | ALLOW   | Takes only JSON; the shape comes from the explicit `AS` list, not a table. Its rowtype-taking sibling `json_populate_record(null::t, …)` IS denied — the two must not be swept together. |
| `SELECT nextval('users_id_seq')`                          | ALLOW   | Deliberate. Part of a normal write idiom already governed by `table_access` / `block_dml`; standalone reach is burning sequence values, and gaps are ordinary Postgres behavior. |

Every case above was ALLOW in 0.19.0 and earlier, with the audit row recording
`tables_touched: []`.

---

## Known limitations

The following shapes currently **allow** when an audit mindset would
prefer a deny. They are documented gaps, not patched-around bypasses —
Midplane ships with a small, predictable rule surface, and tightening
any of these adds policy state we'd rather defer to a follow-up release.

| SQL                                            | Verdict | Why it's a gap |
|------------------------------------------------|---------|----------------|
| `SELECT my_udf()` wrapping a denied builtin    | ALLOW   | `dangerous_function` matches on the function NAME, so it cannot see into a `SECURITY DEFINER` UDF whose body calls `pg_read_file`. Not solvable from the AST — `REVOKE EXECUTE ... FROM PUBLIC` on the underlying builtin is the defense that holds. |
| `BEGIN`                                        | ALLOW   | Transaction control statement. Midplane commits per query, so BEGIN is a no-op for the pipeline. |
| `VACUUM users`                                 | ALLOW   | Performance side effects (locks, IO) but no data mutation. |
| `PREPARE my_p AS SELECT 1`                     | ALLOW   | Session-state mutation. Tightening requires session-scope tracking; deferred. |
| `DEALLOCATE my_p`                              | ALLOW   | Symmetric to PREPARE. Same gap. |

If your threat model needs any of these tightened today, that is a
known gap rather than a bug — please open an issue and we'll either
backport the tightening or prioritize it for a follow-up release.

---

## How to extend

1. Add a test in the matching `packages/engine/test/adversarial/<category>.test.ts`.
2. Add the row in this document. Cite the bypass logic.
3. Run `bun test` from the workspace root.

The corpus is the contract. The doc reads from the tests, not the
other way around.
