---
status: DRAFT
---
# Masking transform catalog: v2.0 → v2.2

Branch: `lange-labs/pg-anonymizer-masking` | Drafted 2026-06-22, after column-level
dynamic masking (#105) and the masked-preview surface (#108) shipped; updated after
`null-out` (#111) landed Phase 2.0 in source.

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

Two v1 properties motivated what follows: redaction **changed a column's type**
(`int`/`timestamptz` → the string `"***"`) — answered by `null-out` in Phase 2.0
below — and a transform's only parameter is still baked into its **name**
(`keep-last-4`), which Phase 2.1 resolves.

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
   type. We need a type-preserving redaction primitive. (Shipped as `null-out` in
   Phase 2.0, #111.)

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
| `null-out` | destroy | any | **same (NULL)** | n/a | ✅ #111 |
| `full-redact` | destroy | any | text | n/a | (have) |
| `partial{keepStart,keepEnd,glyph}` | partial | text | text | ✅ | 2.1 |
| `consistent-hash` | pseudonymize | any | text | ✅ | (have) |
| `generalize{granularity}` | generalize | date/ts · numeric | **date · numeric** | ✅ | 2.1 |
| `pseudonymize{kind}` | pseudonymize | text | text (realistic) | ✅ | 2.2 |
| `noise{ratio}` | noise | numeric | numeric | ❌ (flagged) | 2.2 |

`keep-last-4` is retired in 2.1 — `partial{keepEnd:4}` replaces it (see migration below).

## Phase 2.0 — `null-out` ✅ shipped (#111)

The type-preservation floor — the highest-leverage, lowest-cost move, now landed in
source. A type-preserving redaction primitive: any input → SQL `NULL`, valid for
every Postgres type. Closes the correctness gap that made redacting numeric/date PII
unsafe, and gives `consistent-hash` a type-preserving sibling for non-text columns.

As built:

- **Engine**: `"null-out"` in `TRANSFORM_NAMES`; one `applyTransform` case returning
  the `null` sentinel (`engine/.../masking/transforms.ts`). The exhaustiveness guard
  (`never`) is intact, so the fail-closed posture is unchanged. NULL already passed
  *through* the masker; this makes NULL a transform **target** — every value becomes
  NULL — distinct from the passthrough of an already-NULL input (called out in the
  module header).
- **Policy**: `"null-out"` added to `MASK_TRANSFORMS` — still a bare string, **no
  schema migration**. Flows unchanged through `validateColumnMasks`, `emitColumnMasks`
  (YAML), the dashboard picker, and the engine zod schema.
- **Scanner**: generalized *past* the plan. Rather than enumerate numeric/date
  categories, `classifyColumn` now downgrades **any** text-token suggestion
  (`keep-last-4`/`full-redact`) to `null-out` whenever the column type isn't text-like
  (`isTextType`, `apps/web/src/lib/pii-heuristics.ts`). So a suggested mask can never
  silently change a column's type — for every current and future non-text category,
  not just the ones we thought to list.
- **UI**: one more option in the picker, enabled for all types (no type-gate, unlike
  `keep-last-4`).
- **Fail-closed**: unchanged — `null-out` is in-domain for every type, so it never
  rejects on type grounds.

Shipped with no migration and no engine version bump beyond the enum. Tested on both
sides of the boundary; the `check:transforms` drift guard stays green.

### Open: engine image publish + pin bump (engine-first sequencing)

`null-out` is in the source on both sides of the deployable boundary, but the
**deployed engine image is still pinned at `0.12.0`, which predates it**
(`OSS_ENGINE_IMAGE` in `packages/router/src/oss-image.ts`). Until `engine-v0.13.0` is
cut (CI builds + publishes `midplane/midplane:0.13.0` + digest) and the pin bumped, a
spawned `0.12.0` engine fails **closed** on the unknown transform: the picker offers
`null-out` and serializes it into the policy YAML, but the engine rejects the whole
result set (safe — never leaks — but the picked mask breaks the agent's query).
Engine-first ordering (engine code → image publish → pin bump → cloud offering) closes
that window. Tracked in `TODOS.md` ("Publish engine image + bump pin for the
`null-out` transform"); the pin SSOT + drift sites are in AGENTS.md ("OSS image
version pin sites"). This is a **deploy gate, not a code gate** — it must clear before
`null-out` is offered to live cloud projects.

## Phase 2.1 — value-shape migration + `partial` + `generalize` ✅ in source

The phase that unlocks parametric transforms and the *generalize* rung. Now the head
of the queue, behind only the 2.0 engine-publish deploy gate above — it carries the
one schema migration the rest of the catalog rides on, so it's worth landing before
2.2's dictionary weight.

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

- The `column_masks` column is already jsonb, so adding the tagged-object form is
  a **data-shape evolution, not a DDL change**. Masking is pre-launch (no stored
  masks to preserve), so `keep-last-4` is retired outright rather than carried
  through a back-compat reader + codemod — `partial{keepEnd:4}` replaces it.
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

### As built

The migration landed once and the rest of the catalog rides on it. Tested on both
sides of the boundary; the `check:transforms` drift guard stays green.

- **Value shape**: `MaskRule` is a discriminated union on both sides
  (`engine/.../masking/transforms.ts`, `packages/db/src/policy.ts`) — param-free
  presets stay bare strings, parametric transforms are `{ t, … }` objects. The
  `column_masks` jsonb needs no DDL. `keep-last-4` is retired outright (pre-launch,
  no stored masks to preserve): it's gone from the catalog on both sides, and
  `partial{keepEnd:4}` expresses it and more.
- **Engine**: `applyTransform(rule, value, ctx)` switches on the discriminant with
  exhaustiveness `never` guards on **both** the preset and parametric arms — an
  unknown preset OR an unknown `t` fails closed (`UnknownTransformError`). `partial`
  generalizes `keep-last-4` (`keepStart`/`keepEnd`/`glyph`, short-value guard
  intact). `generalize` truncates dates to year/month/day (canonical date string)
  and buckets numerics to a width; an out-of-domain value redacts to NULL
  (fail-**safe**, never the original).
- **Policy**: `validateColumnMasks` validates per-`t` with bounds (`keepStart +
  keepEnd ≤ 64`, single-char `glyph`, `granularity` in the enum or a positive
  number, `noise.ratio ∈ (0, 10]`) and normalizes to canonical keys so stored jsonb
  carries no junk; `emitColumnMasks` serializes presets inline and parametric rules
  as deterministic **nested YAML blocks** (verified to round-trip through the engine
  parser). The engine zod schema is the parse-time twin — a bad param fails CLOSED
  at boot.
- **Scanner**: `ssn`/`credit_card`/`phone` now suggest `partial{keepEnd:4}`; `dob`
  suggests `generalize{year}` on date/text columns (birth-year — the identifier
  dies, age-cohort analytics survive), downgrading to `null-out` only when the
  column type can't carry it. The spike tier (`pseudonymize`, `noise`) is never a
  suggestion.
- **UI**: `TransformSelect` renders per-transform parameter inputs
  (`keepStart`/`keepEnd`/`glyph`, granularity, kind, ratio), type-gated to each
  transform's input domain (partial/pseudonymize → text, generalize → date/numeric,
  noise → numeric).
- **Drift guard**: `check:transforms` now compares the full catalog **and** the
  param enums/bounds, so a cloud that allowed a param range the engine caps (e.g.
  `noise{ratio:20}`) would fail CI, not just an unknown name.

## Phase 2.2 — the spike tier (`pseudonymize`, `noise`) ✅ in source

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

### As built

Both spike-tier transforms landed on the 2.1 value shape (so 2.1 and 2.2 share one
schema migration rather than two).

- **`pseudonymize{kind}`**: `dict[kind][ HMAC(salt, value) mod len ]` over TS-literal
  dictionaries (`engine/.../masking/dictionaries.ts`) embedded at compile time —
  module constants, **not** `readFileSync` assets (which a `bun build --compile`
  binary would ENOENT, per the same learning that governs `schema.sql`). Kinds:
  `email`, `name`, `first_name`, `last_name`, `phone` — the realistic-fake subset of
  the scanner's categories, so scan → suggest-to-mask → pseudonymize is one path.
  Deterministic + salt-scoped (same guarantee as `consistent-hash`), emits a
  fake-but-stable value of the right shape; never a scanner default — the floor
  stays deterministic redaction.
- **`noise{ratio}`**: proportional ±`ratio` jitter on numerics — the catalog's one
  explicitly **non-deterministic** transform. Integer inputs stay integers; a
  non-numeric value redacts to NULL (fail-**safe**). The picker flags it "breaks
  joins"; the scanner never suggests it.

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

1. **2.0 — `null-out`.** ✅ shipped (#111). No migration; fixed the type-collapse
   gap and made numeric/date PII safe to redact; the scanner now downgrades every
   text-token suggestion to `null-out` on non-text columns. Highest leverage per
   line.
2. **2.1 — value-shape migration + `partial` + `generalize`.** ✅ in source. The one
   schema migration; retires `keep-last-4` outright (pre-launch, no stored masks)
   in favor of `partial{keepEnd:4}`; adds the generalize rung (birth-year, salary
   bands) for analytics utility.
3. **2.2 — `pseudonymize` + `noise` (spike).** ✅ in source. Dictionaries embedded in
   the binary as module constants; `noise` introduces the flagged non-deterministic
   class. Gated, never default.

### The deploy gate (shared across 2.0 + 2.1 + 2.2)

All three phases are in source on both sides of the boundary, but the **deployed
engine image is still pinned at `0.12.0`** (`OSS_ENGINE_IMAGE` in
`packages/router/src/oss-image.ts`), which predates `null-out` and every parametric
transform. Until an engine image carrying these transforms is published (CI builds
`midplane/midplane:X.Y.Z` + digest via the `engine-v*` workflow) and the pin bumped,
a spawned `0.12.0` engine fails **closed** on an unknown transform / param: the
picker offers it and serializes it into the policy YAML, but the engine rejects the
result set (safe — never leaks — but the picked mask breaks the agent's query).
**Engine-first ordering** (engine code → image publish → pin bump → cloud offering)
closes that window. This is a **deploy gate, not a code gate**: the pin SSOT + drift
sites are in AGENTS.md ("OSS image version pin sites"); the bump must clear before
any of these transforms is offered to live cloud projects.

Every phase preserves the v1 invariants: deterministic floor (plus the one flagged
non-deterministic `noise`), fail-closed on unprovable provenance or an unknown
transform, fail-safe (redact to NULL) on an out-of-domain parametric value, scanner
suggests but never auto-applies, salt required to boot.
