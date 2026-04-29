# Adversarial SQL corpus

Every shape in this document is a real test in
[`packages/engine/test/adversarial/`](../packages/engine/test/adversarial).
The corpus exists to answer one question: *what does Midplane V1 actually
catch, and where are its limits?* It is intentionally short on marketing
and long on SQL.

V1 ships four policy rules, in this evaluation order:

1. `parse_error` — input couldn't be parsed
2. `multi_statement` — input parsed to more than one top-level statement
3. `writes_require_approval` — input contains a write at any AST depth
4. `tenant_scope_missing` — opt-in. With a `users → org_id` mapping and
   `tenant_id=42`, every read of a mapped table needs a literal
   `WHERE org_id = 42` predicate at the same SelectStmt scope, reachable
   through `AND` only

V1 is **conservative by default**: when in doubt we deny. False positives
(legitimate queries refused) are bugs we triage in V1.5. Bypasses are
release blockers.

---

## 1. writes_require_approval (recursive AST detection)

A write anywhere in the AST denies. Top-level, inside a CTE, inside a
subquery, inside a UNION arm, inside a JOIN — the recursive walker
finds it.

| SQL                                                                         | Verdict | Rule                       | Why this matters |
|-----------------------------------------------------------------------------|---------|----------------------------|------------------|
| `DELETE FROM users`                                                         | DENY    | `writes_require_approval`  | Unbounded delete (PocketOS-style); V1 default-read-only. |
| `DELETE FROM users WHERE id = 1`                                            | DENY    | `writes_require_approval`  | Bounded delete still denies — V1 does not infer "scoped enough". |
| `UPDATE users SET name='b' WHERE org_id=42`                                 | DENY    | `writes_require_approval`  | Even with a tenant predicate, an UPDATE is a write. |
| `UPDATE a SET n=1 FROM b WHERE a.id=b.id`                                   | DENY    | `writes_require_approval`  | Multi-table UPDATE form. |
| `INSERT INTO users (org_id, name) VALUES (42, 'a')`                         | DENY    | `writes_require_approval`  | Plain INSERT. |
| `INSERT INTO logs (msg) VALUES ('x') RETURNING id, msg`                     | DENY    | `writes_require_approval`  | RETURNING does not change classification — still a write. |
| `INSERT INTO t (x) VALUES (1) ON CONFLICT (x) DO NOTHING`                   | DENY    | `writes_require_approval`  | UPSERT idempotency does not exempt the write. |
| `INSERT INTO t (x,y) VALUES (1,2) ON CONFLICT (x) DO UPDATE SET y = excluded.y` | DENY | `writes_require_approval` | UPSERT with conflict-update branch. |
| `MERGE INTO target … WHEN MATCHED … WHEN NOT MATCHED …`                     | DENY    | `writes_require_approval`  | MERGE is a write regardless of which arm fires. |
| `DROP TABLE x`                                                              | DENY    | `writes_require_approval`  | DDL. |
| `TRUNCATE t`                                                                | DENY    | `writes_require_approval`  | DDL. |
| `CREATE TABLE foo (id int)`                                                 | DENY    | `writes_require_approval`  | DDL. |
| `CREATE TABLE foo AS SELECT * FROM users`                                   | DENY    | `writes_require_approval`  | CTAS — write in disguise. |
| `ALTER TABLE users ADD COLUMN flag boolean`                                 | DENY    | `writes_require_approval`  | DDL. |
| `CREATE INDEX idx_users_email ON users (email)`                             | DENY    | `writes_require_approval`  | DDL. |
| `CREATE VIEW v AS SELECT 1`                                                 | DENY    | `writes_require_approval`  | DDL. |
| `REFRESH MATERIALIZED VIEW v`                                               | DENY    | `writes_require_approval`  | Materialized-view rebuild. |
| `GRANT SELECT ON users TO some_role`                                        | DENY    | `writes_require_approval`  | DCL. |
| `REVOKE SELECT ON users FROM some_role`                                     | DENY    | `writes_require_approval`  | DCL. |
| `GRANT admin TO some_user`                                                  | DENY    | `writes_require_approval`  | Role membership. |
| `CREATE SCHEMA s`                                                           | DENY    | `writes_require_approval`  | DDL. |
| `CREATE ROLE bob`                                                           | DENY    | `writes_require_approval`  | DDL. |
| `CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql`            | DENY    | `writes_require_approval`  | DDL. |
| `CREATE DATABASE d`                                                         | DENY    | `writes_require_approval`  | DDL. |
| `ALTER DOMAIN d SET DEFAULT 1`                                              | DENY    | `writes_require_approval`  | DDL. |
| `CREATE RULE r AS ON SELECT TO t DO INSTEAD SELECT 1`                       | DENY    | `writes_require_approval`  | DDL. |

### Hidden inside a CTE

This category is the canonical recursive-detection case. Codex flagged it
during eng review; the walker exists to close it.

| SQL                                                                                           | Verdict | Rule                       |
|-----------------------------------------------------------------------------------------------|---------|----------------------------|
| `WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x`                                       | DENY    | `writes_require_approval`  |
| `WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x`                                    | DENY    | `writes_require_approval`  |
| `WITH x AS (INSERT INTO y (n) VALUES (1) RETURNING *) SELECT * FROM x`                        | DENY    | `writes_require_approval`  |
| `WITH a AS (SELECT 1), b AS (DELETE FROM y RETURNING n) SELECT * FROM a, b`                   | DENY    | `writes_require_approval`  |
| `WITH outer AS (WITH inner AS (DELETE …) SELECT … FROM inner) SELECT * FROM outer`            | DENY    | `writes_require_approval`  |
| `WITH d AS (DELETE FROM y RETURNING id) INSERT INTO archive (id) SELECT id FROM d`            | DENY    | `writes_require_approval`  |
| `WITH RECURSIVE r AS (…), w AS (DELETE FROM y RETURNING id) SELECT * FROM r, w`               | DENY    | `writes_require_approval`  |
| `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x WHERE EXISTS (SELECT 1 FROM d …)`    | DENY    | `writes_require_approval`  |

### Hidden inside set-ops

UNION / INTERSECT / EXCEPT arms are visited as virtual SelectStmt scopes
by the walker — writes hidden in any arm via a CTE still trip the rule.

| SQL                                                                          | Verdict | Rule                       |
|------------------------------------------------------------------------------|---------|----------------------------|
| `WITH d AS (DELETE … RETURNING id) SELECT … FROM x UNION SELECT id FROM d`   | DENY    | `writes_require_approval`  |
| `WITH d AS (DELETE … RETURNING id) … INTERSECT SELECT id FROM d`             | DENY    | `writes_require_approval`  |
| `WITH d AS (DELETE … RETURNING id) … EXCEPT SELECT id FROM d`                | DENY    | `writes_require_approval`  |

### Opaque procedural body (DO blocks)

`libpg_query` keeps the `DO $$ … $$` body as an opaque string literal.
We can't see inside, so we deny outright — even read-only bodies. This
is conservative-by-default in action.

| SQL                                              | Verdict | Rule                       |
|--------------------------------------------------|---------|----------------------------|
| `DO $$ BEGIN DELETE FROM users; END $$`          | DENY    | `writes_require_approval`  |
| `DO $$ BEGIN PERFORM 1; END $$`                  | DENY    | `writes_require_approval`  |
| `DO $tag$ BEGIN PERFORM 1; END $tag$`            | DENY    | `writes_require_approval`  |

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

Opt-in. Once a customer maps `users → org_id`, every read of `users`
needs a literal `WHERE org_id = <context.tenant_id>` reachable through
`AND` conjunctions, at the **same SelectStmt scope** as the table
reference. UNION arms, CTE bodies, and subqueries each get their own
scope check.

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
| `SELECT * FROM users WHERE org_id IN (42)`                   | DENY    | V1 conservative: operator must be `=`, not `IN`. |
| `SELECT * FROM users WHERE org_id::text = '42'`              | DENY    | V1 conservative: cast fails the literal extractor. |
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
`writes_require_approval` denies writes first; this section exercises
the rule in isolation. V1 conservative posture: any DML on a mapped
table denies regardless of WHERE.

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

| SQL                                                             | Verdict (under V1 read-only) |
|-----------------------------------------------------------------|------------------------------|
| `INSERT … RETURNING id`                                         | DENY (`writes_require_approval`) — parses fine |
| `UPDATE … RETURNING id, msg`                                    | DENY (`writes_require_approval`) |
| `INSERT … ON CONFLICT (x) DO NOTHING`                           | DENY (`writes_require_approval`) |
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

`writes_require_approval` denies more than DML. NOTIFY publishes a
pubsub event; LISTEN/UNLISTEN mutate session subscription state; LOCK
acquires a transaction-scoped lock with availability impact;
CALL/EXECUTE invoke stored code; COPY moves data on the server
filesystem. All deny.

| SQL                                                  | Verdict |
|------------------------------------------------------|---------|
| `CALL my_proc()`                                     | DENY (`writes_require_approval`) |
| `EXECUTE my_prepared`                                | DENY (`writes_require_approval`) |
| `NOTIFY ch, 'msg'`                                   | DENY (`writes_require_approval`) |
| `LISTEN ch`                                          | DENY (`writes_require_approval`) |
| `UNLISTEN ch` / `UNLISTEN *`                         | DENY (`writes_require_approval`) |
| `LOCK TABLE users IN ACCESS EXCLUSIVE MODE`          | DENY (`writes_require_approval`) |
| `LOCK TABLE users`                                   | DENY (`writes_require_approval`) |
| `COPY t FROM '/etc/passwd'`                          | DENY (`writes_require_approval`) |
| `COPY t TO '/tmp/leak'`                              | DENY (`writes_require_approval`) |
| `COPY t FROM STDIN`                                  | DENY (`writes_require_approval`) |
| `COPY (SELECT * FROM users) TO '/tmp/dump'`          | DENY (`writes_require_approval`) |

---

## Known V1 limitations

The following shapes currently **allow** when an audit mindset would
prefer a deny. They are documented gaps, not patched-around bypasses —
V1 ships with a small, predictable rule surface, and tightening any of
these adds policy state we'd rather defer to V1.5.

| SQL                                            | V1 verdict | Why it's a gap |
|------------------------------------------------|------------|----------------|
| `SELECT pg_terminate_backend(123)`             | ALLOW      | SELECT-wrapped admin function. AST-level write detection cannot tell side-effecting `pg_*` functions from pure ones without a denylist. **V1.5: function-side-effects denylist.** |
| `SELECT pg_cancel_backend(123)`                | ALLOW      | Same shape. |
| `SELECT lo_unlink(1)`                          | ALLOW      | Large-object unlink — a write disguised as a SELECT. |
| `BEGIN`                                        | ALLOW      | Transaction control statement. V1 commits per query so BEGIN is a no-op for the pipeline. |
| `VACUUM users`                                 | ALLOW      | Performance side effects (locks, IO) but no data mutation. |
| `PREPARE my_p AS SELECT 1`                     | ALLOW      | Session-state mutation. Tightening requires session-scope tracking; deferred to V1.5. |
| `DEALLOCATE my_p`                              | ALLOW      | Symmetric to PREPARE. Same V1 gap. |

If your threat model needs any of these tightened today, that is a
known V1 gap rather than a bug — please open an issue and we'll either
backport the tightening or prioritize it for V1.5.

---

## How to extend

1. Add a test in the matching `packages/engine/test/adversarial/<category>.test.ts`.
2. Add the row in this document. Cite the bypass logic.
3. Run `bun test` from the workspace root.

The corpus is the contract. The doc reads from the tests, not the
other way around.
