---
status: DRAFT
---
# Column masking: source-side rewrite (the proper fix for ISSUE-007)

Drafted 2026-06-30, after prod E2E found that enabling masking on **one** column
blanket-denies **all** aggregate/computed outputs database-wide (ISSUE-007, HIGH).
Pre-launch, so we change the architecture rather than patch around it.

**Amended 2026-06-30 after a CEO-mode plan review (HOLD SCOPE) + Codex outside
voice.** The amendments are folded inline below and recorded in the review report at
the end. The two that changed the shape of the design: `consistent-hash` moves
*into* the rewrite (it can't compose otherwise), and the post-exec masker is
**retained** as a runtime-flagged fallback (not deleted).

Supersedes the enforcement architecture in
[`masking-transform-catalog.md`](./masking-transform-catalog.md) ("mask at the
engine via AST projection, fail-closed, *after* execution"). It keeps that doc's
**transform taxonomy** and policy plumbing; it replaces the **enforcement
mechanism**. The earlier doc said "the architecture is *not* [pg_anon]." This doc
is the reversal: we adopt pg_anon's *architecture* (mask under the computation),
not just its taxonomy — because the post-execution approach is the direct and
unavoidable cause of the blast radius.

## The problem, precisely

Today masking decides per **output column** using the driver's RowDescription
provenance (`mask-result-set.ts`). Any computed output — `tableOid === 0`:
aggregate, expression, set-op, row serialization — is **rejected** whenever the
connection has *any* mask active (`mask-result-set.ts:122`), with no per-query
lineage:

```
customers.credit_card masked  ⇒  SELECT count(*) FROM products   → DENY
                                  SELECT max(price) FROM products → DENY
                                  SELECT count(*) FROM orders     → DENY
```

A computed output carries no base-column provenance, so the post-exec masker
*cannot* tell whether it drew from a masked column — it can only fail closed on
all of them. **Masking and analytics become mutually exclusive.** For a product
sold as "Safe Postgres for your team's AI agents" where a large share of agent
queries are aggregates, this is a dealbreaker.

The research pass (2026-06-30; sources in the ISSUE-007 thread) confirmed every
mature masker avoids this by applying the mask **at the source column reference,
beneath the computation**, never at the output:

| System | Mask applied | `count(*)` over an unrelated table | `avg(masked_col)` |
|---|---|---|---|
| PostgreSQL Anonymizer | RTE → masking subquery, parse-analysis time | untouched | `avg(mask(col))` |
| Snowflake DDM | policy expr at every column occurrence | untouched | runs (documented use case) |
| Databricks UC masks | mask UDF in the column's table scan | untouched | runs |
| BigQuery | per-column policy tag at query runtime | untouched | runs |
| Apache Ranger | table → masking CTE | untouched | runs |
| **Midplane (today)** | **post-exec, reject `tableOid=0`** | **DENY** ← bug | **DENY** |

The output-filter camp is a camp of one, and the blast radius is its signature
failure. SQL Server DDM and Oracle Redaction sit in neither camp — they mask only
the projected scalar and let `WHERE`/`JOIN`/aggregate run on **raw** data, so they
*fail open* (documented inference bypass). Source-rewrite is the only design that
is **both** blast-radius-free **and** fail-closed on inference.

## Decision

Move masking from **post-execution output-provenance rejection** to
**pre-execution source-side rewrite**: when a query references a masked base
relation, wrap that relation in an inline subquery that projects every column with
the masked ones replaced by their mask expression, then execute the rewritten SQL.

```sql
-- user sends:
SELECT count(*), avg(age) FROM customers WHERE country = 'DE'
-- engine executes (credit_card masked, age unmasked):
SELECT count(*), avg(age) FROM (
  SELECT id, name, age, country,
         md5(current_setting('midplane.mask_salt') || credit_card::text) AS credit_card
  FROM customers
) customers WHERE country = 'DE'
```

One wrap per masked **source relation** handles every downstream reference at
once — projection, `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY` all resolve to the
subquery's masked output column. We do **not** rewrite each occurrence (Snowflake's
model); wrapping the RTE is strictly simpler and covers them uniformly. Postgres
*usually* flattens the trivial subquery (subquery pull-up), so `count(*) FROM
customers` often never evaluates the mask expression — but pull-up is a restricted
"simple subquery" path, not a guarantee (CEO review §7 / Codex #6), so treat it as
a likely optimization, not a correctness or perf assumption. A referenced-but-
unmasked table (`products`) is left byte-for-byte untouched.

This is, deliberately, still "AST projection, fail-closed, no name-matching" — the
masking design we approved. It keys on the relation's **identity** (OID, resolved
to the partition parent), not column names, exactly as today. We are moving *where*
the projection is applied (under the query, not over the result), not abandoning
the principle.

### Why not the alternatives

- **Managed masking views + `search_path` pin** (pg_anon's legacy model; Midplane
  provisions a `midplane_mask` schema of views in the customer DB). Composes
  perfectly and *structurally* closes the opaque-function hole (a `query_to_xml`
  string resolves through the masked view), with **no perpetual allowlist and no
  deparse-on-a-security-boundary**. It reuses machinery we already have: the
  executor's single chokepoint that opens a transaction and pins `search_path` with
  `SET LOCAL` (`pg-pool.ts:33`). Its cost is DDL + a REVOKE'd role in the customer
  DB, against the "point it at your DB, no schema changes" promise. **CEO review
  (D6) promoted this from "optional self-host hardening" to the *named fallback*:**
  if the Phase-0 emission spike or the function-identity allowlist (below) proves
  too hairy, B is where we go — both the architecture review and the Codex outside
  voice independently judged B technically sounder than A. It is also the self-host
  default (Phase 4).
- **Narrow the post-exec gate** (function allowlist + unmasked-table gate, keep
  rejecting computed outputs over masked tables). The original band-aid. Un-breaks
  the reported cases but keeps a bespoke design no one else runs and can never
  *mask* `avg(masked_col)`. **No longer the fallback** (B replaced it) — but the
  retained post-exec masker (below) gives us the same runtime safety valve.

## Mechanism

### Pipeline placement

Current `handle()` (`engine.ts`): `parse → policy → audit(ATTEMPTED) →
audit(DECIDED) → execute → mask(post-exec) → audit(EXECUTED|FAILED)`. New:

```
parse → policy(+AST mask-safety gate) → audit(ATTEMPTED) → audit(DECIDED)
      → REWRITE(+catalog mask-safety checks) → execute → audit(EXECUTED|FAILED)
```

The mask-safety enforcement is **split across two phases** (CEO review §1/§9, Codex
#4), because `Engine.decide()` (the cloud policy-test preview) stops *before* any DB
socket opens (`engine.ts:397`), while the rewrite needs catalog access *after*
ALLOW:

- **AST-only checks run in the policy phase** so `decide()`/preview sees them: the
  function/operator allowlist *shape* (obvious off-allowlist spellings — see
  covert-channel guard). Decidable from the parse tree alone.
- **Catalog-dependent checks run at rewrite time** (post-DECIDED, pre-execute):
  relkind resolution — **including the view-reference reject** (eng review §1: you
  cannot tell a view from a table syntactically; `relkind` comes from `pg_class`, so
  this is NOT an AST-only/policy-phase check) — the full column list, input-type
  domain, function *identity* resolution, and the emission self-check. A preview can
  therefore say ALLOW while live execution rejects on one of these, **including a
  query that references a view**. **This divergence is documented and acceptable** — the preview answers "would policy allow this?", not "will the
  rewrite succeed?"; the audit `DECIDED` row still records the policy verdict before
  any rewrite, preserving the locked pipeline's intent-before-execution guarantee.
- Rewrite runs **only** when `columnMasks` is non-empty (else true no-op — preserves
  the fast path), and **only** when the runtime `mask_source_rewrite` flag is on
  (else fall back to the retained post-exec masker — see below).
- **Prerequisite T0 — transaction-scoped execution (eng review, Codex #1/#4).** The
  catalog `resolveByName`, the function-shadow scan, the `SET LOCAL
  midplane.mask_salt`, and the execution of the rewritten SQL must all happen on the
  **same checked-out client/transaction**. Today the catalog resolver and
  `executor.query()` use *separate* connection paths, and `query()` runs outside the
  `BEGIN`/`SET LOCAL search_path` block (`pg-pool.ts:33,127`) — so name resolution
  and execution could land on different connections with different effective
  `search_path`, and the salt GUC might not be on the execution client. Phase 1 must
  extend the executor with a transaction-scoped "resolve + set GUCs + execute
  rewritten" path and bind the catalog resolver to that client. This is a real
  prerequisite, not a detail.
- Audit logs the **original** SQL + fingerprint (rewrite is an enforcement detail),
  with a `columns_masked` / `mask_rewritten: true` annotation on EXECUTED.

### Identifying masked source relations

Walk the raw libpg_query parse tree for every read-position `RangeVar` (FROM,
JOIN, subquery, CTE body — at every depth; CTE *names* excluded, same exclusion
the IR already computes). For each, resolve identity → "is this masked?":

1. Canonicalize `[schemaname.]relname`: null schema → `public` (matches the
   executor's `SET LOCAL search_path = public, pg_catalog` pin).
2. Look up `schema.relname` in `columnMasks`. **Also** resolve the inheritance/
   partition parent (a child of a masked parent must be wrapped; masks are declared
   on the parent). The mask is keyed on the parent's `schema.table`.
3. `relkind`:
   - `r`/`p` (table/partition) → eligible to wrap.
   - `v`/`m` (view/matview) → **reject the query, fail closed** (a view can expose
     a masked base column and we don't resolve view lineage yet — same stance as
     `mask-result-set.ts:150`). Deferred: view-definition resolution.
   - anything else (foreign table, …) → reject.
   - cannot resolve the name → reject (retryable: refresh catalog once).

This needs a **by-name** catalog path the resolver doesn't have today — `catalog.ts`
resolves **by OID** (from RowDescription). Add `resolveByName(refs)` →
`{ oid, relkind, topParent, fullColumnList }`, cached per connection, fetching
`pg_class`/`pg_namespace`/`pg_inherits` and the **complete** `pg_attribute` column
list per masked table (we need *every* column to rebuild the projection, not just
the masked ones). `resolveByName` must canonicalize and resolve names under the
**same pinned `search_path`** the executor uses (`public, pg_catalog`), so "what we
wrapped" matches "what executes" (eng review §1, A3).

**Module placement (eng review §1, A1).** The rewriter names libpg_query AST nodes
(`RangeVar` → `RangeSubselect`). The engine has a hard invariant — `normalize.ts`:
*"the ONLY file that may name libpg_query AST nodes"* — so the rewriter lives under
`dialects/postgres/` beside `normalize.ts`, **not** in the dialect-agnostic
`masking/`. Cleanest long-term shape: a `Dialect.rewrite(ast, masks, catalog)` hook
so `masking/` stays AST-free and a future MySQL dialect supplies its own rewriter +
`toSql`. The dialect-agnostic `masking/` keeps only the transform catalog/types.

**Staleness is now correctness-critical and must fail closed** (CEO review §1/§2):
unlike today's post-exec path (catalog populated lazily from result OIDs), the
rewrite resolves names → columns *before* execution. A stale column list that omits
a newly-added column would silently drop it from the wrap. So: on any by-name
resolution miss or any signal the cached column set may be stale, **reject + refresh
+ retry once** (mirroring the existing retryable path); never emit a wrap from an
unproven column list.

### Building the wrap

For a masked relation `t` with columns `c1…cn` and masks on a subset:

```sql
(SELECT  c1, mask_expr(c2) AS c2, c3, …, mask_expr(cn) AS cn  FROM <original-ref>) <alias>
```

- Project **all** user columns (`pg_attribute` attnum > 0, not dropped) in attnum
  order, names preserved, so `SELECT *`, positional refs, and unmasked-column refs
  all still bind.
- Preserve the original **alias** (or synthesize `alias = relname` when none) so
  **alias-qualified** refs (`t.c2`) still bind. **Schema-qualified column refs
  (`public.t.c2`) do NOT bind after the wrap** (eng review, Codex #5a — a subquery
  alias is a single identifier, not a schema.relation), so v1 **rejects** a
  schema-qualified column reference to a wrapped table (fail closed). Rewriting those
  `ColumnRef`s to drop the qualifier is a later option.
- `<original-ref>` keeps the source's own schema-qualification, so the inner read
  is unambiguous regardless of `search_path`.
- **Quote every generated identifier** (schema, relname, column, alias) with proper
  PG identifier quoting (CEO review §3). The column/table names come from the
  catalog and can be exotic (`"; --"` is a valid quoted identifier); an unquoted
  splice is an identifier-injection vector.
- **Escape/parameterize string-literal mask params too** (eng review §2, C2 — a
  second injection vector distinct from identifiers). `partial`'s `glyph` is a
  config string interpolated into the emitted expression (e.g. `repeat('<glyph>',
  …)`); a glyph containing `'` breaks out of the literal. `toSql` must escape string
  literals, not string-concat them. Numeric params (`keepStart`, `keepEnd`,
  `granularity`, `ratio`) are zod-validated at config save, so they're safe to
  inline; the string-valued ones are not.
- **Limitation — the wrap is not perfectly semantics-preserving** (Codex #8). It
  projects only named user columns, so **system columns** (`ctid`, `tableoid`,
  `xmin`, …) are dropped, and a **whole-row / composite reference** (`t.*` as a
  composite, `to_jsonb(t)`, rowtype casts) sees the *derived subquery* rowtype, not
  the base-table rowtype. v1: **reject** a query on a wrapped table that references a
  system column or takes a whole-row composite of it (fail closed); document.
  (`to_jsonb` over a wrapped relation is already blocked by the covert-channel
  allowlist; `t.*` expanded to a column list is fine — only the composite form is
  the issue.)

### Emission: span-splice vs. whole-AST deparse

We must turn the rewrite into SQL text to send over the wire. Two options.

**Spike result (2026-06-30): GO — emission risk retired.** Both strategies were run
against a live Postgres 16 fixture over a 12-query corpus (joins, CTEs, set-ops,
self-joins, aggregates over masked columns, `GROUP BY`/`ORDER BY` on masked,
`SELECT *`, spaces-around-the-dot). **11/11 equivalence:** span-splice and whole-AST
deparse both execute, return *identical* result sets (cross-validating), and actually
mask (no raw values leak). The Approach-B trigger condition did not occur.
**Decision: span-splice is primary** (it kept the user's SQL byte-for-byte — only the
wrap injected — the right posture for a security boundary), **and deparse is retained
as a differential-test oracle** in the Phase-1 harness (the two agreeing is a free
cross-check that catches splice-boundary bugs). Spike artifacts:
`.context/spike-emission/` (gitignored, reproducible).

- **Localized span-splice.** Use each masked `RangeVar`'s source `location` to
  splice the wrap in place, leaving the rest of the user's SQL **byte-for-byte
  verbatim**. Only the injected subquery is synthesized — keeping the deparse attack
  surface to the few strings *we* generate, instead of round-tripping the user's
  whole query through a deparser that could subtly change semantics (the right risk
  posture for a security control). Process splices right-to-left by offset so earlier
  offsets stay valid. **Risk (Codex #6):** libpg_query exposes a node *start*
  `location`, not an extent, so we must compute the FROM-item end boundary
  (`[schema.]relname [[AS] alias]`, with quoting/comments) ourselves — no parser
  support. The spike must prove this across the SQL surface we accept.
- **Whole-AST deparse** (`pgsql-deparser` / `@pgsql/deparser`, the round-trip path
  libpg-query's own docs point to; we have no deparser today — `parse.ts` imports
  only `parseSync`/`loadModule`). Mutate `RangeVar` → `RangeSubselect`, deparse the
  whole tree. Cleaner, but every deparse divergence is a potential
  correctness/security bug; needs a strong round-trip equivalence harness, and the
  new dependency must be vetted.

Either way: **fail closed** — if emission can't be proven (location gap, deparse
round-trip mismatch on a self-check), reject the query rather than execute an
unverified rewrite. If the spike shows neither path is trustworthy across our SQL
surface, that is the signal to switch primary to Approach B (D6 fallback).

### Transforms as SQL expressions — the real constraint

Source-rewrite requires each transform to compute **in the database**. They split by
whether they need the secret salt or the compiled-in dictionary, and by whether they
preserve the column's type — the split drives the rollout and the fail-closed rules:

| transform | SQL form | salt | type behavior | path |
|---|---|---|---|---|
| `null-out` | `NULL::<coltype>` | no | **type-preserving** | rewrite |
| `full-redact` | `'***'::text` | no | **collapses to text** → text columns only | rewrite |
| `partial` | `left()`/`right()`/`repeat()`/`length()` + `CASE` short-value guard | no | text-only (already type-gated) | rewrite |
| `generalize` (date) | `date_trunc('year'|'month'|'day', col)` | no | stays date family | rewrite |
| `generalize` (numeric) | `floor(col / w) * w` | no | stays numeric | rewrite |
| `noise` | `col * (1 + (random()*2-1)*ratio)` | no | stays numeric (non-deterministic by design) | rewrite |
| `consistent-hash` | `md5(current_setting('midplane.mask_salt') || col::text)` | **yes** | collapses to text-hex | **rewrite** (salt via GUC) |
| `pseudonymize` | dictionary lookup — hard in SQL | yes | text-only | **projection-only v1** (post-exec) |

**Amendment (CEO review D5 / Codex #1).** The earlier plan kept `consistent-hash`
on the post-exec masker to keep the salt out of the customer DB. That is **unsound
and self-defeating**: (a) once a table is wrapped, every column it emits is
`tableOid = 0`, which the post-exec masker rejects — so a salted transform *cannot*
ride the post-exec path on a wrapped relation; (b) `consistent-hash` exists
precisely so an agent can `JOIN`/`GROUP BY` on a masked column, which the post-exec
masker can never support (it rejects those computed outputs). So `consistent-hash`
**must** be in the rewrite to do its job. It goes in-DB, salt via GUC.
`pseudonymize` (the only dictionary transform) stays **projection-only** in v1 — the
mask-safety gate rejects a *computed* output drawing from a pseudonymized column,
and the retained post-exec masker masks it when projected directly.

**Type behavior (Codex #7).** Only `null-out` is type-preserving. `full-redact` and
`consistent-hash` collapse to text; `partial`/`pseudonymize` are text-only. In
rewrite mode a transform that changes a column's type is only safe where the
column's downstream uses tolerate the new type. The input-type domain check that
`mask-result-set.ts` already enforces (`checkInputDomain`) moves to rewrite time and
keeps its fail-closed posture — an out-of-domain pairing **rejects** (see D4 below),
it does not silently coerce. **Enforce the domain at config-save too (eng review,
Codex #5b):** today `full-redact`/`null-out`/`consistent-hash` are treated as
domain-free, so a `full-redact` on an int column *works* post-exec (returns `'***'`)
but would become a rewrite-time reject (type collapse to text). Add the type-domain
check to `validateColumnMasks` so an incompatible mask is rejected at authoring time,
not discovered as a query-time reject; query-time stays the fail-closed backstop.

- **Salt handling (decision: accept, mitigate).** `consistent-hash` needs the
  secret salt in-DB. The threat: a party holding the *masked outputs + the salt but
  not raw-table access* (a read-replica analytics role, a log-scraping SaaS, a
  managed-PG provider's logs) could rainbow-table a low-cardinality masked column.
  **Decision: accepted with mitigation** — the customer's own DB already holds the
  raw values, so the threat population is narrow. Pass the salt **once per
  transaction** via `SET LOCAL midplane.mask_salt = '<salt>'` and reference
  `current_setting('midplane.mask_salt')`, so it stays out of `pg_stat_statements`
  (normalized) and per-query text; it appears only under `log_statement='all'`,
  which is customer-controlled. **Align the two paths' token formula (eng review D2,
  Codex #3).** The rewrite emits `md5(salt || col::text)`; the retained post-exec
  masker currently emits truncated HMAC-SHA256 (`transforms.ts:175`). Because the
  fallback flag can route consistent-hash either way, the two MUST produce the same
  token or a flag flip silently re-tokenizes and breaks joins/groups/cache across
  requests. So change the JS path to `md5(salt || stringify(value))` to match SQL —
  exact for text columns (the common consistent-hash case); the rare non-text case is
  documented/gated. Pre-launch this swap has zero migration cost (dynamic masking, no
  stored tokens).
- **`pseudonymize`** end state (deferred): materialize the dictionary as a
  `VALUES`-CTE indexed by `hash % len` for full composition. v1 is projection-only;
  don't let it block the launch fix.

### Salt-missing & type-incompatible: fail closed (D4)

Two failure classes get an explicit fail-closed rule (CEO review §2/D4), never a
silent NULL or a raw Postgres error:

- **Salt GUC missing — verified worse than assumed (Phase-0 spike).** You cannot
  rely on Postgres to error when the salt is absent. The spike confirmed: a *fresh*
  connection errors on `current_setting('midplane.mask_salt')`, but after **any**
  `SET LOCAL … ; COMMIT` the custom GUC reverts to **`''` (empty string), not
  undefined** — so on a **pooled connection that previously served a masked query**,
  `current_setting` returns `''` silently, yielding `md5('' || col)` — an **unsalted,
  rainbow-tableable hash, with no error and no NULL.** (Measured: `md5(''||cc)`
  matched the unsalted JS hash exactly.) So the missing-ok form (NULL→silent-NULL)
  *and* the strict form (''→silent-unsalted on pooled reuse) are both unsafe. The
  engine MUST **set the salt per transaction on the exact execution client and
  verify it is present and non-empty before executing**, treating absent/empty as a
  **reject** (sanitized). This is part of the T0 transaction-scoped contract — the
  pooling reuse is exactly the Codex #4 trap.
- **Type-incompatible masked column** — a transform whose output type doesn't fit
  the column's downstream use **rejects** with a clear, sanitized "this masked
  column can't be used this way" message. Never let a raw PG type error surface.

### Semantic consequence (intended)

Wrapping the source means the query's own `WHERE`/`JOIN`/`GROUP BY`/`ORDER BY` on a
masked column now operate on the **masked** value. `WHERE credit_card = '4111…'`
matches nothing (closes the inference bypass that sinks SQL Server DDM / Oracle
Redaction); `JOIN ON a.email = b.email` joins on the deterministic token (holds for
deterministic transforms, breaks for `noise` — by design); `ORDER BY masked_col`
orders by the *masked* value, so `LIMIT 10` returns a different set of rows than the
user might expect; a range filter on a `generalize`d column filters on the bucket.
This is correct and unavoidable — you cannot both hide a value and filter precisely
on it. It must be **documented in the masking UI** (cross-team TODO): *masking a
column changes the meaning of filters, joins, and ordering on it.*

**Residual inference (don't oversell).** Order/format-preserving transforms
(`generalize`) still leak buckets: `MAX(generalize(salary))` reveals the top band, a
range filter narrows it. This is acceptable for an agent-analytics threat model but
must not be marketed as "aggregates over masked columns are safe." (See the
statistical-disclosure caveats in the ISSUE-007 research thread.)

### Covert-channel guard (still required — rewrite is blind to opaque reads)

Source-rewrite only masks relations it can **see** as RangeVars. A function that
reads a masked table through a runtime string the parser can't see —
`query_to_xml('SELECT credit_card FROM customers')` (core, no extension), `dblink`,
an FDW, or a `SECURITY DEFINER` UDF — is invisible to the rewrite and would return
raw PII. So we keep a fail-closed allowlist gate, and **it ships in Phase 1 with the
rewrite, not after** (Codex #3 — rewrite without the gate is fail-open, not an
incremental improvement). Active only when masking is on:

- Inventory **every** function, operator, **and cast/expression construct** in the
  statement — a full expression-tree walk (CEO review §3; the IR doesn't surface
  this today, add a `functionsInvoked` field to `NormalizedProgram`). Operators and
  casts are covert channels too (a custom operator or cast invokes a function).
- Allow only a vetted mask-safe builtin set: `count/sum/avg/min/max`, arithmetic,
  comparison, boolean, plus the functions our own mask expressions use.
- **Reject** the query if *any* invoked function/operator/cast is off-allowlist —
  user-defined, set-returning, reflective (`query_to_xml`, `to_jsonb` on a row),
  FDW/`dblink`, anything that can read data not derivable from its syntactic table
  arguments.
- **Resolve identity, not spelling** (Codex #5 — critical). A name-based allowlist
  over the raw AST is a *spelling* allowlist; raw libpg_query parsing is syntactic,
  and under our pinned `search_path = public, pg_catalog` a `public.sum(...)` UDF
  *shadows* the builtin and would pass a name check. **Implementation (eng review,
  Codex #2):** per-query overload resolution from the raw AST is intractable
  (`FuncCall`/`A_Expr`/`TypeCast` don't tell you which `pg_proc`/`pg_operator` entry
  PG picks after type inference). Instead, make it a **per-connection shadow scan** —
  one `pg_proc`/`pg_operator` query at catalog-resolve time confirming no
  allowlisted builtin name is shadowed by a user-schema object ahead of `pg_catalog`
  in the path — plus deny *any* schema-qualified or non-`pg_catalog` function/operator
  call outright. (Pinning `pg_catalog` first for function resolution is a candidate
  hardening.) The AST phase still pre-filters obvious off-allowlist *shapes* for the
  preview; the shadow scan is per-connection, not per-query.
- **The check must recurse into nested calls.** PostgreSQL Anonymizer's
  [GHSA-468r-mhwc-vxjc](https://github.com/google/security-research/security/advisories/GHSA-468r-mhwc-vxjc)
  was bypassed by a non-recursive allowlist: `pg_catalog.upper(public.elevate()::text)`
  — a benign outer call wrapping an untrusted inner one. Walk the whole tree.

### Write path (UPDATE/DELETE/INSERT)

- **`RETURNING` a masked column** → wrap the **RETURNING list** expressions
  (`RETURNING id, mask_expr(credit_card) AS credit_card`), a projection rewrite.
- **`WHERE` / `ON CONFLICT` predicates on a masked column are an inference hole**
  (Codex #2). `UPDATE … WHERE credit_card = '4111…'` (or a `DELETE`, or an
  `ON CONFLICT DO UPDATE` predicate) evaluates against the **raw** column and leaks
  values via the rows-affected count — the write target isn't a FROM we can wrap.
  **v1: reject** any write whose `WHERE`/`ON CONFLICT` predicate references a masked
  column while masking is active (fail closed). Later: rewrite to
  `WHERE id IN (SELECT id FROM (<wrapped>) WHERE <masked-pred>)`.
- **Writes *to* a masked column** pass through (masking is read-side); only what's
  *returned* is masked.

### The retained post-exec masker (D3 surviving half + D5)

`mask-result-set.ts` is **retained, not deleted** (CEO review D3). Its naive
`tableOid===0` reject is incompatible with rewritten output (those columns are now
computed), so it does not run *over* rewritten queries. It earns its keep three ways:

1. **Runtime-flagged rollback fallback.** A `mask_source_rewrite` flag routes
   enforcement back through the post-exec masker (today's behavior, blast radius and
   all) if the rewriter misbehaves in prod — an in-prod A→safe-state valve without a
   redeploy. **Do not delete the post-exec masker in the same release that ships the
   rewrite.**
2. **`pseudonymize` projection handler** (v1, until the dictionary-CTE lands).
3. **Defense-in-depth** for the rewrite path comes from the covert-channel gate, the
   fail-closed emission self-check, and the rewrite's determinism + tests — not from
   the provenance reject. A residual *taint* tripwire (assert no un-wrapped masked
   base column is reachable in the executed tree) is deferred unless the spike shows
   we need it.

### Edge cases — all fail closed

- **View/matview referenced while masking active** → reject (v1). Defer lineage.
- **System-column or whole-row composite reference on a wrapped table** → reject (v1).
- **Unresolvable / stale / post-cache-build table** → reject, refresh catalog, retry once.
- **Salt GUC missing / type-incompatible masked column** → reject (D4).
- **Write `WHERE`/`ON CONFLICT` on a masked column** → reject (v1, Codex #2).
- **`SELECT *`** → handled: the wrap re-exposes every user column by name.
- **Set-ops / CTEs / correlated subqueries** → each masked RangeVar wrapped at its
  own depth; multiple references → multiple independent wraps.
- **Multi-statement** (`statementCount > 1`) is already denied upstream.
- **Off-allowlist function/operator/cast** → reject (covert-channel gate).
- **Emission failure / unproven rewrite** → reject.

## Observability

First-class for a security control (CEO review §8 — the original draft barely
covered it):

- **Metrics:** mask-safety-gate rejections (a spike means probing **or**
  false-positives blocking legit queries), rewrite failures (spike ⇒ emission bug),
  by-name catalog cache misses, masked queries executed, fallback-path invocations
  (the `mask_source_rewrite` flag firing).
- **Tripwire alert:** if the rewriter ever fails *open* — emits a query touching a
  masked relation with no wrap. This should be impossible; instrument it so we hear
  if it isn't.
- **Debuggability:** log the **salt-redacted** rewritten SQL so a masking complaint
  3 weeks later is reconstructable. Never log the salt or unredacted rewritten SQL.
- **Error hygiene (CEO review §3):** strip the rewritten SQL and any GUC/salt
  reference from PG errors before they reach the agent.

## Catalog & config impact

- `catalog.ts`: add `resolveByName` (name → oid/relkind/parent/**full column
  list**), cached per connection, **fail-closed on staleness**. The by-OID path is
  retained (the post-exec masker fallback still uses it).
- `engine.ts` masking config (`{ columnMasks, salt, resolver }`) gains the rewrite
  hook and the `mask_source_rewrite` flag; `salt` is emitted via `SET LOCAL
  midplane.mask_salt` per transaction.
- `packages/db/src/policy.ts`: `ColumnMasksConfig`, `emitColumnMasks`, the
  `requires_features: [column_masks]` skew block, and `validateColumnMasks` are
  reused. A new `requires_features` token (`mask_source_rewrite`) defends cloud↔engine
  skew (an old engine that can't rewrite must refuse a rewrite-requiring policy,
  never silently leak).
- `transforms.ts`: grows a `toSql(rule, colExpr, coltype)` emitter beside
  `applyTransform` (both retained — the post-exec masker still uses `applyTransform`).
  Drift-checked against the cloud catalog (`scripts/check-mask-transforms.ts`),
  extended to compare **outputs** (value-corpus parity), not just kinds.

## Testing

- **Emission spike gate (Phase 0):** round-trip / equivalence harness over a corpus
  of accepted SQL — rewritten query returns the same rows as the original except
  masked columns carry the mask expression. Reuse the IR-port verdict-equivalence
  pattern.
- **SQL fuzz / property test** of the rewriter (CEO review §6): random valid SQL →
  assert semantic equivalence + every masked-relation reference wrapped. The test
  that lets you sleep for a security-critical rewriter.
- **Blast-radius regression** (the bug): `count(*)`/`max()`/`avg()` over unmasked
  tables return real values with a mask active; over a masked table, return correct
  aggregates with the masked column never exposed raw.
- **Adversarial covert-channel suite — run continuously** (new PG/extension versions
  add reflective functions): `query_to_xml`, `dblink`, a `SECURITY DEFINER` UDF, an
  FDW, the GHSA nested-function bypass (`pg_catalog.upper(udf())`), and a
  `public.sum(...)` UDF shadowing the builtin (identity vs spelling, Codex #5) —
  every one rejected.
- **Write-path:** `UPDATE/DELETE … WHERE masked_col = …` and `ON CONFLICT` predicate
  on a masked column → rejected (Codex #2). `RETURNING` masked column → masked.
- **Soundness side-deps:** partition child of a masked parent (wrapped), view over a
  masked table (rejected), system-column reference on a wrapped table (rejected),
  CTE/subquery/set-op depth, `SELECT *`, multi-reference, `WHERE`/`JOIN`/`ORDER BY`
  on a masked column (operates on masked value).
- **Transform-SQL parity:** each `toSql` form matches `applyTransform` for the same
  (value, salt) on a value corpus.
- **Fallback regression (mandatory, eng review §3 IRON RULE):** with
  `mask_source_rewrite` **off**, results are byte-identical to today's post-exec
  masker. This protects the rollback valve from bit-rot — if the fallback silently
  diverges, the valve is fake. The retained masker keeps its existing test suite.
- **Plan-regression (eng review §4, P4):** the equivalence harness asserts not just
  row-equivalence but an **EXPLAIN plan-cost delta** within a warn-threshold —
  subquery pull-up isn't guaranteed (Codex #6), so a multi-masked-table join could
  un-flatten into a pathological plan that row-equivalence alone won't catch.

## Failure-mode registry (fail-closed posture)

```
CODEPATH                         | FAILURE                       | RESULT        | USER SEES
---------------------------------|-------------------------------|---------------|------------------------
by-name catalog resolve          | name unresolvable / stale     | reject+retry1 | "re-scan schema, retry"
relkind = view/matview           | view lineage unknown          | reject        | "query the base table"
relkind = foreign/other          | unprovable source             | reject        | "unsupported relation"
input-type domain (rewrite-time) | transform vs col type mismatch| reject (D4)   | "can't mask this way"
salt GUC missing                 | SET LOCAL not applied          | reject (D4)   | sanitized error
emission (splice/deparse)        | can't prove rewrite           | reject        | sanitized error
covert-channel gate              | off-allowlist fn/op/cast      | reject        | "unsupported function"
write WHERE/ON CONFLICT on mask  | raw-data inference hole       | reject        | "can't filter on masked col"
system column / whole-row composite | wrap drops it              | reject        | "unsupported on masked table"
rewriter bug (defense-in-depth)  | fails to wrap                 | tripwire alert + flag→fallback
```

No row is RESCUED=N / USER-SEES=Silent. The one residual silent path the design
explicitly closes is salt-missing (was: silent NULL → now: reject, D4).

## Phasing

0. **Spike (de-risk emission) — DONE 2026-06-30: GO.** Both span-splice and deparse
   proved sound on live PG (11/11 corpus equivalence; see Emission section).
   Span-splice is primary, deparse is the differential-test oracle. Approach B stays
   the fallback only for *other* reasons (not emission). The spike also surfaced the
   salt-GUC pooling leak (folded into the salt fail-closed rule) and confirmed the
   schema-qualified-colref reject is necessary.
1a. **T0 prerequisite — transaction-scoped executor** (eng review, Codex #1/#4):
   extend the executor with a "resolve + set GUCs + execute rewritten" path on one
   checked-out client; bind the catalog resolver to it; align the consistent-hash
   token formula across the JS and SQL paths (D2); move the type-domain check into
   `validateColumnMasks` (config-save). Phase 1 cannot ship soundly without this.
   **SCAFFOLDED 2026-06-30:** `TxClient` + optional `Executor.withTransaction`
   (`executor.ts`), the `PgPoolExecutor.withTransaction` impl (`pg-pool.ts`,
   BEGIN+SET LOCAL search_path+TxClient+COMMIT/ROLLBACK), `buildCatalogByName`
   (`catalog.ts`), and the `runSourceRewrite` coordinator with fail-closed
   `setMaskSalt` (set_config+verify, the spike's leak guard) + the `SourceRewriter`
   seam (`source-rewrite.ts`). 10 unit tests pass; engine + mcp-server typecheck
   clean; existing masking/executor suites green (no regression).
1b. **Postgres `SourceRewriter` (span-splice) — BUILT 2026-06-30:**
   `dialects/postgres/source-rewrite.ts` (`postgresSourceRewriter`: `collectRefs` +
   `rewrite`, span-splice keeping the user SQL verbatim, quoted identifiers,
   fail-closed rejects for view/foreign relkind, unresolved-masked-table, out-of-
   domain transform, and the schema-qualified-colref the live-PG spike proved
   errors) + `dialects/postgres/transform-sql.ts` (`transformToSql` for all 6
   transforms, type-domain fail-closed, escaped string params, consistent-hash via
   the salt GUC). 16 unit tests pass (incl. self-join double-wrap, masked-view
   reject, verbatim-clause preservation); typecheck clean.
1c. **Covert-channel mask-safety gate (ET2) — BUILT 2026-06-30:**
   `dialects/postgres/mask-safety.ts` — `checkMaskSafeShape` (sync, policy-phase:
   deny-by-default allowlist over functions/operators, denies schema-qualified/UDF;
   catches `query_to_xml`/`dblink`/`to_jsonb`/`current_setting`/`pg_read_file`) +
   `shadowScan` (per-connection `pg_proc` check that no allowlisted builtin name is
   shadowed by a `public.*` UDF — Codex #5 identity-not-spelling). 13 tests pass.
   `MASK_SAFE_FUNCTIONS` is a conservative SEED (deny-by-default ⇒ sound while
   incomplete) flagged for security review + expansion before ship.
1d. **handle() wiring — BUILT 2026-06-30:** `MaskingConfig.sourceRewrite = { enabled,
   rewriter }`; `Engine.applySourceRewrite` runs the SHAPE gate (covert-channel,
   AST-only, before opening a txn) then `runSourceRewrite` (shadow scan + resolve +
   span-splice rewrite + exec on one client), with the retained post-exec masker as
   the fallback when the flag is off or the executor has no `withTransaction`. The
   rewrite reject path reuses the existing `column_masking` denial + EXECUTED audit
   (`columns_masked`). Integration tests prove handle() executes the *rewritten* SQL
   and the gate denies `query_to_xml`/`current_setting` without executing. Full
   engine suite 926 pass / 0 fail; both packages typecheck clean; verdict baseline
   regenerated for the 2 new gate-test SQLs.
1e. **Soundness completeness — BUILT 2026-06-30:**
   - **Write-path:** the write TARGET (UPDATE/DELETE/INSERT/MERGE `relation`) is
     never wrapped (fixes a real bug — the earlier walk would have wrapped a write
     target into invalid `UPDATE (SELECT …) SET …`); a write to a masked table that
     references a masked column in `WHERE`/`ON CONFLICT`/`RETURNING` (or any masked-
     target `MERGE`) fails closed. Read-position tables inside a write (UPDATE…FROM,
     INSERT…SELECT) are still wrapped. (libpg_query serializes `relation` inline, no
     `{RangeVar:…}` wrapper — handled.)
   - **System-column reject:** `ctid`/`tableoid`/`xmin`/… on a wrapped table fails
     closed (they're attnum<0, absent from the wrap projection).
   - **ET5 token alignment:** the JS `consistent-hash` now emits `md5(salt||text)`
     matching the SQL `md5(current_setting(salt)||col::text)`, so the fallback flag
     is token-stable. **Verified on live PG:** the JS `applyTransform` token equals
     the in-DB value.
   - **ET7 live-PG harness:** `source-rewrite.live.test.ts` (gated on
     `MASKING_LIVE_PG_DSN`) runs the *shipped* rewriter + `buildCatalogByName` +
     `transformToSql` + salt GUC against real PG16 — count-over-unmasked untouched,
     aggregate-over-masked equivalence, full-redact + no-raw-leak, consistent-hash
     token parity, and WHERE-on-masked returns 0 (inference closed). 5/5 pass.
   Full engine suite 934 pass / 27 skip / 0 fail; both packages typecheck clean.
1f. **PR #130 review fixes — BUILT 2026-06-30:**
   - **RETURNING star/whole-row leak:** the write-clause guard now rejects
     `RETURNING *` / `t.*` (A_Star) and a whole-row composite of the target
     (`RETURNING <target>`), not just an explicitly-named masked column — the write
     target isn't wrapped and handled rewrites skip post-exec masking, so those forms
     would have returned the raw masked value. RETURNING of only-unmasked columns
     still passes.
   - **CTE shadowing:** a CTE that shares a name with a masked table (e.g. `WITH
     customers AS (…) … FROM customers`) is rejected — `FROM <name>` binds to the CTE
     in SQL, but the catalog lookup would wrap it as the base table (wrong semantics /
     reads a relation the query didn't reference at that scope). A non-colliding CTE
     that reads a masked table in its body still wraps the base table correctly.
   - **Pre-exec masking rejects no longer audited as EXECUTED:** a source-rewrite
     denial (shape gate / salt / shadow / rewrite reject) runs no SQL, so it's now
     recorded as a `FAILED` event with a distinct `column_masking` error_class —
     a denied covert-channel attempt is never logged as an executed query. (Post-exec
     masker rejects, which DID run, still write EXECUTED with `masking_rejected`.)
   Full engine suite 939 pass / 0 fail; live-PG harness 5/5; both packages tsc clean.
   **Remaining for Phase-1:**
   - **ET6 (config-save type-domain) — DEFERRED, not a soundness gap.** `transformToSql`
     already enforces the type domain fail-closed at query time. Catching it at
     *authoring* needs a column-type source threaded into `validateColumnMasks`
     (the save path — `setColumnMasks` — takes only the config today; it would need
     a schema-type fetch against the customer DB) plus duplicating the transform↔
     typcategory rules in `packages/db` (cross-package, drift-checked). A control-
     plane feature, not a rewriter fix; do it when the mask-authoring UI wires column
     types through.
   - RETURNING *masking* (vs the current reject), observability metrics/tripwire.
1g. **Allowlist security review — DONE 2026-06-30.** Stated the safety criterion (a
   builtin is mask-safe iff every value it observes derives from its syntactic args +
   non-secret session context — the wrap already masked any masked-column arg), then
   expanded `MASK_SAFE_FUNCTIONS` across the provably-safe families (statistical/
   ordered-set/window aggregates, transcendental math, pure string incl. `regexp_replace`/
   `encode`/`sha*`, date/time incl. `date_bin`) and the operators (POSIX regex,
   bitwise) — still deny-by-default. Kept the dangerous families excluded with the
   mechanism documented (dynamic SQL, FS/LO, GUC introspection incl. the salt,
   object-name/regclass deref, reflective/admin/DoS, whole-row/JSON serialization and
   SRFs — the last two deferred, not dismissed). An **adversarial Codex pass found a
   real High**: the operator allowlist was spelling-only and the shadow scan covered
   `pg_proc` but not `pg_operator`, so a `public.||` redefining a builtin (body calling
   `current_setting`/`query_to_xml`) would bypass the gate. **Fixed:** the shadow scan
   now resolves operator identity via `pg_operator` too. Verified end-to-end on real
   PG16 (the PoC operator is created and rejected). Full engine suite 948 pass / 0
   fail; live harness 6/6. (Residual, tracked: RETURNING/JSON-serialization deferral.)
1b. **Core rewrite + covert-channel gate together** (Codex #3 — they ship as one):
   `null-out`, `full-redact`, `partial`, `generalize`, `noise`, `consistent-hash`;
   by-name catalog (fail-closed staleness, shared search_path), FROM-wrap (quoted
   identifiers + escaped string params, schema-qualified-colref reject),
   RETURNING-list rewrite, write-predicate reject, salt via `SET LOCAL`,
   `functionsInvoked` IR field + per-connection identity/shadow allowlist, the
   `mask_source_rewrite` flag with the **retained** post-exec masker as fallback.
   Resolves ISSUE-007. Observability metrics + tripwire land here too.
2. **Soak + flip default:** run with the flag on in staging/canary, watch the
   tripwire and gate-rejection metrics, then make rewrite the default. The post-exec
   masker stays as the flagged fallback for at least one release cycle (do not delete
   it with Phase 1).
3. **`pseudonymize` full composition:** dictionary-CTE (until then projection-only
   via the retained masker).
4. **(Fallback / self-host) managed-views mode:** the D6 fallback if the Phase-0
   spike fails, and the self-host default — managed `midplane_mask` views + REVOKE'd
   role + `search_path` pin, reusing the `pg-pool.ts:33` chokepoint; structurally
   closes the opaque-function hole without the allowlist.

Engine bump + `OSS_ENGINE_IMAGE` pin update + deliberate image release accompany
Phase 1 (the `requires_features` token is the safety interlock; deploy the
rewrite-capable engine first, then flip the cloud to emit rewrite-requiring policies).

## Open questions (for sign-off)

Resolved in the 2026-06-30 CEO review (see review report): salt transport (accepted,
`SET LOCAL`), `consistent-hash` placement (rewrite, D5), `pseudonymize` v1
(projection-only), view handling (reject v1), post-exec masker (retained as fallback,
D3), Approach (A primary, B fallback, D6).

Still open:
1. **Emission method** — span-splice vs. `pgsql-deparser`; Phase-0 spike decides.
   Implement both for cross-checking, or commit to one?
2. **`mask_source_rewrite` flag granularity** — global, per-connection, or
   per-project? (Per-project lets us canary one customer.)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | HOLD SCOPE; 6 decisions (A, D5 hybrid-correction, fail-closed, D6 B-fallback); 0 critical gaps open |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | CEO pass: 9 findings; eng pass: 6 build-mechanics findings; all 15 absorbed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | HOLD-equiv; D1 (all-6 transforms) + D2 (align consistent-hash); 6 fold-ins; 0 critical gaps; T0 prerequisite surfaced |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a | no UI scope (engine-internal) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** 15 findings across two passes, all folded in. CEO pass reshaped the design (D5 hybrid correction, D6 B-as-fallback, identity allowlist, write-predicate reject). Eng pass surfaced the **T0 prerequisite** (transaction-scoped executor — resolve+salt+execute must share one client), made the identity-allowlist a per-connection shadow scan (not per-query), aligned the consistent-hash token formula across paths (D2), corrected the schema-qualified-colref binding claim, and moved type-domain checks to config-save.
- **CROSS-MODEL:** Strong agreement, no contradiction. CEO-pass Codex and the architecture review both independently judged Approach B sounder (→ B promoted to named fallback, D6). Eng-pass Codex extended the build plan without disputing any prior conclusion. Both models concur the design is sound; the risk is concentrated in the Phase-0 emission spike and the T0 executor work.
- **VERDICT:** CEO + ENG CLEARED — ready to implement. Build order: T0 (transaction-scoped executor) → Phase-0 emission spike (gates / triggers Approach-B fallback) → Phase 1 (rewrite + gate + all 6 transforms + fallback flag). 24 build tasks across two task JSONLs.

NO UNRESOLVED DECISIONS
