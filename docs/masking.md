# Masking

Masks are applied at the source: the gateway rewrites the statement so each
masked column is replaced by its mask wherever the table is read, before any
filter, join or aggregate sees it. `WHERE email = 'jane@example.com'` then
compares the masked value, so a mask can't be probed through a predicate.

## Transforms

| Rule | Columns | Result |
| --- | --- | --- |
| `none` | any | The raw value: reviewed and left clear |
| `full-redact` | any | `***` for text; NULL of the column's own type otherwise |
| `null-out` | any | NULL of the column's own type |
| `consistent-hash` | text | `sha256(salt ‖ value)` in hex: the same value, the same token, so joins and counts work ([the salt](secrets.md)) |
| `{ t: partial, keepStart, keepEnd, glyph }` | text | The middle replaced by `glyph` (`•`); a value no longer than what's kept is masked whole |
| `{ t: generalize, granularity: year \| month \| day }` | dates and times | Truncated, keeping the column's type |
| `{ t: generalize, granularity: <n> }` | numbers | Rounded down to a multiple of `n` |
| `{ t: noise, ratio }` | numbers | Multiplied by a random factor within ±`ratio` |

A rule that doesn't fit its column's type denies the statement rather than run
a mask Postgres would reject.

## New and unreviewed columns

In a table with a mask entry, a column without its own rule is **fully
redacted until someone reviews it**, so a column added later never appears
unmasked by surprise. Mark a reviewed column `none`. The dashboard counts
columns awaiting review and suggests masks for columns whose names look like
personal data.

## What else changes once a database has masks

To keep masks from being worked around, a database with any mask entry also:

- runs only allowlisted built-in functions, and denies a built-in name that
  is also defined in `public`;
- denies casts to types defined outside `pg_catalog` (a type's input function
  is code);
- denies the catalog views that publish values or statement text
  (`pg_stats`, `pg_settings`, `pg_stat_activity`, `pg_stat_statements`);
- denies writes that would copy a masked value into a clear column, renaming
  or moving a masked table, and DDL that evaluates raw values (a `CHECK`, an
  index predicate);
- drops Postgres' error `DETAIL` and `HINT`, which can quote the failing row.

## Known limits

- **`noise` is redrawn on every read**, so averaging many reads converges on
  the raw value. Use it against casual reading, not a determined agent.
- **`consistent-hash` is an oracle for whoever can write the table:** an agent
  that can insert a value it chose learns that value's token, and can then
  find rows holding it.
- **Views that reach a masked table are denied**, not inlined, in this
  version.
- **An intermediate partition's own entry doesn't reach its leaves:** masks
  and labels on a partitioned table's top parent apply to every partition,
  but the catalog records only each partition's top ancestor.

## The public bypass corpus

`packages/corpus` holds the cases Midplane's engine is tested against: SQL,
a policy and a catalog in, the expected decision out, as JSON fixtures. It
includes the masking bypasses we know of (aliases, CTEs, set operations,
subqueries, whole-row functions, casts, predicate oracles, partitions,
catalog views), and every one is denied or masked. Run it with
`pnpm vitest run packages/core`; a case that slips through is a security bug
([SECURITY.md](../SECURITY.md)).

*Tested by* the corpus (`packages/corpus/fixtures/masking*.json` through
`packages/core/test/corpus.test.ts`) and `apps/gateway/test/gateway.e2e.test.ts`
(masked reads against Postgres).
