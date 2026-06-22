---
status: DRAFT
---
# Masking transform catalog: v2.0 → v2.2

Branch: `lange-labs/pg-anonymizer-masking` | Drafted 2026-06-22, after column-level
dynamic masking (#105) and the masked-preview surface (#108) shipped.

Captures where the masking transform catalog goes next, sequenced as three phases
so the additions land as one coherent plan rather than a drip of ad-hoc transforms.
The taxonomy is borrowed from [PostgreSQL Anonymizer](https://postgresql-anonymizer.readthedocs.io/en/stable/)
(`anon`); the architecture is **not** — `anon` is an in-database extension keyed on
DB roles, the opposite of our agentless proxy that masks at the engine via AST
projection, fail-closed. We steal its *taxonomy*, pick the right ~7 of its ~50
functions, and map them onto our enforcement model.

## What shipped (v1)

Three transforms, applied cell-by-cell *after* execution using driver-reported
RowDescription provenance (`tableOid` + `columnAttnum` → catalog → column name →
transform), rejecting the whole result set fail-closed when provenance can't be
proven (computed output, view lineage, unknown OID).

| transform | output | determinism | type behavior |
|---|---|---|---|
| `full-redact` | `"***"` | n/a (constant) | **collapses to text** |
| `consistent-hash` | `HMAC-SHA256(salt, v)[:16]` | deterministic (join-safe) | collapses to text-hex |
| `keep-last-4` | `••••1234` | n/a | text-only (type-gated in UI) |

Surrounding machinery, all reused unchanged below:

- **Policy**: `ColumnMasksConfig = Record<"schema.table", Record<column, MaskTransform>>`
  in `packages/db/src/policy.ts` (`MASK_TRANSFORMS` ~L612), stored as the
  `column_masks` jsonb column (`schema.ts:203`), validated at save
  (`validateColumnMasks`), emitted to engine YAML (`emitColumnMasks` ~L720) with a
  `requires_features: [column_masks]` block for version-skew defense.
- **Engine**: `TRANSFORM_NAMES` + `applyTransform` switch in
  `engine/packages/engine/src/masking/transforms.ts`; `UnknownTransformError` →
  fail-closed reject (never passthrough) defends cloud↔engine skew.
- **Scanner**: zero-engine name+type heuristics (`apps/web/src/lib/pii-heuristics.ts`)
  flag PII columns and *suggest* a transform — no row data read.
- **Salt**: per-project `HMAC(MIDPLANE_MASK_SALT_MASTER, projectId)` injected as
  `MIDPLANE_MASK_SALT`; masks declared without a salt refuse to boot.
- **Preview**: real-execution proof of agent's-eye rows via the MCP `query` tool.

Two v1 properties motivate what follows: redaction **changes a column's type**
(`int`/`timestamptz` → the string `"***"`), and a transform's only parameter is
baked into its **name** (`keep-last-4`).

## What we learned from `anon`

Three steals, in priority order.

1. **The utility ladder.** `anon` organizes masking by *how much utility survives*,
   not by data type — and that axis lines up with the scanner's confidence tiers:

   ```
   destroy → partial → pseudonymize → generalize/noise → fake
    (0 info)  (format)  (join-safe id)  (stats survive)   (realistic)
   ```

   v1 has one rung each at *destroy*, *partial*, and *pseudonymize* (hex flavor).
   The gaps are **generalize/noise** (analytics utility) and **realistic
   pseudonyms** (dictionaries).

2. **`MASKED WITH VALUE NULL` is the type-preservation answer.** This is the most
   important steal. `full-redact → "***"` changes a column's type — tolerable for
   LLM/JSON agents, a latent correctness bug for any agent on the binary/extended
   protocol, and it makes `consistent-hash` on a numeric FK unjoinable agent-side.
   `anon`'s clean answer is masking *to NULL*, type-preserving for every Postgres
   type. We need a type-preserving redaction primitive.

3. **Parametric transforms need a value *shape*, not a name.** `anon` is
   `partial(col, 2, '***', 4)`, `noise(col, 0.33)`, date generalization. We baked
   one param into a name (`keep-last-4`); that's combinatorial
   (`keep-last-2`, `keep-first-1-last-4`, `bucket-by-1000`…). Decide the policy
   value shape once so parametric transforms land without a second jsonb migration.

## The model

The catalog is governed by **two axes** every transform must declare, enforced
fail-closed by the engine and surfaced in the UI:

- **Determinism** — does same input → same output? Deterministic transforms
  preserve joins/grouping; this is the masking *floor*. Non-deterministic ones
  (`noise`) break joins and are opt-in, flagged in the picker, never the default.
- **Type-preservation** — is the output the same Postgres type as the input?
  Type-preserving (`null-out`, numeric `generalize`) vs type-changing
  (`full-redact`, date `generalize` → date, `partial` → text). Type-changing
  transforms carry an input-type domain; an out-of-domain application is a
  fail-closed reject (same path as `UnknownTransformError`), and the UI greys it
  out (as `keep-last-4` already does for non-text).

### Target catalog

| transform | rung | valid input | output type | deterministic | phase |
|---|---|---|---|---|---|
| `null-out` | destroy | any | **same (NULL)** | n/a | **2.0** |
| `full-redact` | destroy | any | text | n/a | (have) |
| `partial{keepStart,keepEnd,glyph}` | partial | text | text | ✅ | 2.1 |
| `consistent-hash` | pseudonymize | any | text | ✅ | (have) |
| `generalize{granularity}` | generalize | date/ts · numeric | **date · numeric** | ✅ | 2.1 |
| `pseudonymize{kind}` | pseudonymize | text | text (realistic) | ✅ | 2.2 |
| `noise{ratio}` | noise | numeric | numeric | ❌ (flagged) | 2.2 |

`keep-last-4` is absorbed by `partial{keepEnd:4}` in 2.1 (see migration below).

## Phase 2.0 — `null-out` (the type-preservation floor)

The highest-leverage, lowest-cost move. A type-preserving redaction primitive: any
input → SQL NULL, valid for every Postgres type. Closes the correctness gap that
makes redacting numeric/date PII unsafe today, and gives `consistent-hash` a
type-preserving sibling for non-text columns.

- **Engine**: add `"null-out"` to `TRANSFORM_NAMES`; one `applyTransform` case
  returning the NULL sentinel. (NULL already passes through the masker; this makes
  NULL a *target*, not just a passthrough.)
- **Policy**: add `"null-out"` to `MASK_TRANSFORMS` — still a bare string, **no
  schema migration**.
- **Scanner**: for numeric/date PII categories (`dob`, numeric `ssn`/`phone`/
  `credit_card`), suggest `null-out` instead of today's downgrade to `full-redact`,
  so a suggested mask never silently changes a column's type.
- **UI**: one more `<option>` in `TransformSelect`, enabled for all types.
- **Fail-closed**: unchanged — `null-out` is in-domain for every type, so it never
  rejects on type grounds.

Ships independently, no migration, no engine version bump beyond the enum.

## Phase 2.1 — value-shape migration + `partial` + `generalize`

The phase that unlocks parametric transforms and the *generalize* rung.

### The policy value shape (the migration done once)

Evolve the bare-string transform into a discriminated union that keeps the
param-free presets as strings and adds an object form for parametric transforms:

```ts
// packages/db/src/policy.ts
export type MaskRule =
  | "full-redact" | "null-out" | "consistent-hash"            // param-free presets
  | { t: "partial";    keepStart?: number; keepEnd?: number; glyph?: string }
  | { t: "generalize"; granularity: "year" | "month" | "day" | number };

export type ColumnMasksConfig = Record<string, Record<string, MaskRule>>;
```

- The `column_masks` column is already jsonb, so this is a **data-shape codemod**
  (string → tagged object for the migrated transforms), not a DDL change. Ship a
  back-compat reader so old rows (`"keep-last-4"`) still parse, then a one-shot
  codemod rewrites `keep-last-4` → `{ t: "partial", keepEnd: 4 }`. The
  `keep-last-4` name then retires.
- `validateColumnMasks` validates per-`t` (bounds: `keepStart`/`keepEnd` ≥ 0 and
  sum ≤ a cap; `glyph` a single char; `granularity` in the enum or a positive
  number). `emitColumnMasks` serializes the object to YAML deterministically.
- Engine `applyTransform` switches on `t`; UI `TransformSelect` renders param
  inputs per transform. Everything downstream keys off the discriminant.

### `partial` (generalizes `keep-last-4`)

Reveal `keepStart` leading + `keepEnd` trailing characters, mask the rest with
`glyph` (default `•`). Text-only, deterministic. Covers more PII formats than the
fixed last-4 (e.g. email local part, `keepStart:2,keepEnd:0`). Inherits
`keep-last-4`'s short-value guard: if `keepStart + keepEnd ≥ len`, fully mask
(never leak a short value).

### `generalize` (the new rung)

Bucket a value to reduce precision while keeping statistical utility — the
`anon` generalization / `date_trunc` idea.

- **Dates/timestamps** → truncate to `year`/`month`/`day`. The `dob` PII category
  becomes birth *year*: the identifier dies, age-cohort analytics survive.
  Output type stays date — **type-changing within the date family** (timestamp →
  date), so it carries a date/timestamp input domain.
- **Numerics** → round to a bucket `width` (e.g. `granularity: 1000` → salary band).
  Output stays numeric.
- Deterministic (pure function of the value), so grouping by the generalized
  column is stable. Type-gated in the UI like `keep-last-4` is today.

## Phase 2.2 — the spike tier (`pseudonymize`, `noise`)

The "PII-detector tier on top" — never the floor, consistent with the approved
masking design. Both are heavier and land behind validation, not on by default.

### `pseudonymize{kind}` (realistic deterministic fakes)

`consistent-hash` proves join-safety but emits hex; a realistic pseudonym keeps
the *shape* (a fake-but-stable email/name) while staying deterministic:
`dict[kind][ HMAC(salt, v) mod len(dict[kind]) ]`. Same input → same fake
(join-safe); different project salt → uncorrelated, same as `consistent-hash`.

- Needs **dictionaries embedded in the compiled binary** — the engine is
  `bun build --compile` and already embeds `schema.sql`; dictionaries ship the
  same way. This is the main cost and why it's 2.2, not 2.1.
- `kind` ∈ the PII categories the scanner already knows (`email`, `name`, `phone`…),
  so scan → suggest → pseudonymize is one path.

### `noise{ratio}` (analytics-preserving, join-breaking)

Additive/proportional noise on numerics (`anon.noise`). The first explicitly
**non-deterministic** transform: it breaks joins/grouping by design, so the picker
flags it ("breaks joins") and it is never a scanner default. Useful where only
aggregate distribution matters and exact values must not survive.

## Out of scope (deferred or not-this-product)

- **`fake_*` (non-deterministic realistic), `random_*`** — no utility over `noise`
  for our model; faking that breaks joins without the deterministic guarantee isn't
  worth the dictionary weight beyond `pseudonymize`.
- **k-anonymity / indirect-identifier analysis** — not a cell transform; belongs in
  the **scanner / exposure report** (flagging quasi-identifier combinations), not
  the post-processor. Track separately.
- **Static masking, anonymous dumps, replica masking** — `anon`'s in-place /
  copy-producing modes. A different product surface (sanitized snapshots for
  dev/test), not our runtime proxy. Explicitly not us.
- **NULL-as-input transforms** — NULL stays NULL (v1 limitation, unchanged);
  `null-out` makes NULL a *target*, not a source to transform.

## Sequencing

1. **2.0 — `null-out`.** No migration, ships now, fixes the type-collapse gap and
   makes numeric/date PII safe to redact. Highest leverage per line.
2. **2.1 — value-shape migration + `partial` + `generalize`.** The one schema
   migration; absorbs `keep-last-4`; adds the generalize rung (birth-year, salary
   bands) for analytics utility.
3. **2.2 — `pseudonymize` + `noise` (spike).** Dictionaries embedded in the binary;
   `noise` introduces the flagged non-deterministic class. Gated, never default.

Every phase preserves the v1 invariants: deterministic floor, fail-closed on
unprovable provenance or out-of-domain transform, scanner suggests but never
auto-applies, salt required to boot.
