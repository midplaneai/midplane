# TODOS — midplane-cloud

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Connections / test-surface follow-ups

### Live E2E flows for the policy test surface (P1 — deferred from plan)
- **What:** Three live E2E specs: (1) new connection → DSN test fails → fix → create;
  (2) connection home → run probes → deny rows render with reasons; (3) edit a table
  policy → re-run probes → verdict reflects the change (exercises push-then-probe).
- **Why:** These are the design doc's success criteria for the trust surface; every
  layer beneath them is unit/route-tested, but nothing walks the real pipe end to end.
- **Context:** Needs engine 0.9.0 (`bun run dev:image` or the published image) + an
  authed browser session. Test plans for /qa exist at
  `~/.gstack/projects/midplaneai-midplane-cloud/*-ship-test-plan-*.md` and
  `*-eng-review-test-plan-*.md`. Existing live specs in `e2e/*.live.e2e.ts` show the
  harness conventions.
- **Depends on:** the connections-ux PR landing.

### Rate limit on the tables introspection route (review deferral)
- **What:** A generous per-customer cap (e.g. 60/min) on
  `GET /api/connections/[id]/tables`.
- **Why:** The route opens a short-lived connection to the customer's own DB per
  uncached call; its siblings (ping 10/min, dry-run 6/min) all carry caps. Deferred
  because the autocomplete is debounced (150ms) + browser-cached (max-age=10), so
  abuse pressure is theoretical until usage data says otherwise.
- **Context:** `checkRateLimit` + shared constants live in `apps/web/src/lib/rate-limit.ts`;
  follow the test-dsn route's shape.

### Extract the saved-db reachability action into a tested lib (review deferral)
- **What:** Move `testReachabilityAction`'s body from
  `app/(app)/connections/[id]/databases/[name]/page.tsx` into a lib helper (the
  `lib/database-form.ts` pattern) and unit-test the rate-limit / decrypt-failure /
  guarded-ping wiring.
- **Why:** It's the third ping surface; the pieces beneath it are tested but the
  wiring isn't. Deferred as thin-wiring risk.

## Guardrails follow-ups (deferred from the dangerous-statement-guardrails ship review)

### Policy-push freshness / engine ack verification (P2)
- **What:** Close the remaining stale-push windows: (1) the Fly adoption push sends the
  spawn-time snapshot — a save committed during the 0–60s adopt window is overwritten
  (the dry-run path got `freshEntries` for this; the spawner has no DB access, so the
  fix needs a callback threaded through `SpawnOptions` or a policy version stamp);
  (2) nothing verifies the engine ACKNOWLEDGED the guardrails section — a pre-0.9.0
  engine acks the YAML while stripping it. The engine's POLICY_RELOADED payload carries
  `sections_changed` + a guardrails posture, and dry-run returns `policy_hash`; either
  is an ack signal `pushPolicy` could require.
- **Why:** Both gaps make the UI/audit claim a posture the serving engine doesn't have —
  the exact lie the guardrails feature exists to prevent. The shipped mitigations
  (stale-image recreate, adoption push, dry-run freshEntries, mid-run hash gate) close
  the common paths; these are the long-tail windows.
- **Context:** `packages/router/src/spawner-fly.ts` (`pushPolicyToMachine`),
  `packages/router/src/admin.ts` (`pushPolicy`), `apps/web/src/lib/connections.ts`
  (`applyPolicyConfigChange` treats delivered:false as success).
- **Also (codex):** guardrail probes only run for flags that are ON — an opt-out is
  unverifiable in the panel (a stale engine still BLOCKING reads as clean). Probing
  opt-outs needs an "expected allow under table_access" row the cloud can't currently
  model without becoming a second decision brain; fold into the ack-verification design.
  And the adoption image check is tag-granular: a re-pushed tag or a list response
  without `config.image` evades it — digest pinning or the engine ack closes that too.

### Harden config-event audit writes (P3)
- **What:** `emitConfigAuditRow` failures are log-and-continue for all config events;
  for security-posture downgrades (GUARDRAILS_CHANGED opt-outs) consider retry,
  alerting, or failing the action.
- **Why:** A transient audit-DB failure during an opt-out currently leaves no attributed
  trail (the engine's POLICY_RELOADED row still lands, but without the actor).
- **Context:** `apps/web/src/lib/connections.ts` (`applyPolicyConfigChange` audit tail).
  Decided 2026-06-12 to keep convention consistency and harden all config events together.

### Optimistic concurrency on policy editors (P3)
- **What:** The guardrails / permission-grid / tenant-scope forms post whole-config
  snapshots; two editors (or two tabs) silently last-writer-win. Send the `applied`
  baseline and reject (or merge per-flag) when the stored row moved.
- **Context:** `apps/web/src/components/guardrails-toggles.tsx` (smallest config object —
  good first candidate), then the sibling editors.

### Extract shared config event-type list in audit SQL (P3)
- **What:** The config/credential event-type IN-list is duplicated in two SQL strings
  (`apps/web/src/lib/audit.ts` ~550 and ~1056). Extract one constant and interpolate.
- **Why:** This ship had to edit both; drift is currently caught by two dedicated tests,
  so this is cleanliness, not correctness.

### Verify server-action error messages survive a prod build (P3)
- **What:** The policy editors render `err.message` from throwing server actions; Next.js
  masks server-action error messages in production builds. Confirm EnginePolicyRejected's
  engine validator body actually reaches the user on a prod build; if masked, convert
  the actions to the return-state pattern (CLAUDE.md documents both).
- **Context:** Affects all three editors equally (pre-existing pattern); flagged by the
  red-team pass on 2026-06-12. A 10-minute manual check on a prod build settles it.

## Masking follow-ups

### Publish engine image + bump pin for `null-out` + phase 2.1 (P0 — BLOCKING, engine-first sequencing)
- **What:** Phases 2.0 (`null-out`) and 2.1 (the `MaskRule` value-shape union +
  `partial` + `generalize`) are in the source on both sides of the deployable
  boundary, but the deployed engine image is pinned at `0.12.0`, which predates
  all of it. Cut one engine release (e.g. `engine-v0.13.0` — CI builds +
  publishes `midplane/midplane:0.13.0` + digest) that carries the union-aware
  zod + `applyTransform` switch, then bump `OSS_ENGINE_IMAGE` in
  `packages/router/src/oss-image.ts`, run `bun scripts/check-image-pin.ts`, and
  update every drift site until green. **Only then** deploy the cloud (the new
  value-shape YAML emit + the DB migration below).
- **Why (2.1 raises the stakes vs 2.0):** 2.0's `null-out` is a bare string an old
  engine merely rejects per-query. 2.1 changes the *value shape*: the cloud now
  emits `partial`/`generalize` as nested **objects** (`{ t: partial, keepEnd: 4 }`),
  which the `0.12.0` engine's zod `ColumnMasksSchema` (bare-string only) rejects
  at **boot** — so the whole DB fails to spawn, not just one query. Engine-first
  ordering closes that window.
- **Migration 0002 is part of the hazard — do NOT run it before the engine bump.**
  `packages/db/migrations/0002_mask_keep_last_4_to_partial.sql` rewrites stored
  `"keep-last-4"` values to `{ "t": "partial", "keepEnd": 4 }`. After it runs, the
  cloud emits the object form for those DBs too — so an existing masked DB on the
  un-bumped `0.12.0` engine would stop spawning. The deploy order is strict:
  **engine image publish → `OSS_ENGINE_IMAGE` bump → cloud deploy (which applies
  0002).** A back-compat reader (`normalizeMaskRule`) already accepts the legacy
  bare `keep-last-4` at read time, so the migration is a data-at-rest cleanup, not
  a correctness prerequisite — it can even be deferred to a deploy *after* the
  engine bump if extra caution is wanted.
- **Context:** Same sequencing as the original masking launch (engine code →
  image publish → pin bump → cloud offering). Pin SSOT + drift sites are
  documented in AGENTS.md ("OSS image version pin sites"); the transform-kind
  drift guard is `bun scripts/check-mask-transforms.ts` (CI: `check-pins.yml`).
  Roadmap for 2.2 (`pseudonymize`/`noise`) is in
  `docs/designs/masking-transform-catalog.md`.

### Publish engine image + bump pin for phase 2.2 (`pseudonymize` + `noise`) (P0 — BLOCKING, the NEXT bump after 2.1)
- **What:** Phase 2.2 adds two transforms to the `MaskRule` union on both sides —
  `{ t: "pseudonymize", kind }` (realistic deterministic fakes from compiled-in
  dictionaries) and `{ t: "noise", ratio }` (the lone non-deterministic, join-
  breaking transform). The source is in the tree on both sides, but the deployed
  engine (`0.12.0`, and even the 2.1 bump above) does NOT know these kinds.
- **Sequencing (a two-step queue):** the 2.1 bump above MUST land first (it
  carries the value-shape union the `0.12.0` engine rejects at boot). 2.2 is the
  NEXT engine release ON TOP of that: cut a new `engine-vX.Y.Z` carrying the
  `pseudonymize`/`noise` `applyTransform` cases + the widened zod union + the
  dictionaries, bump `OSS_ENGINE_IMAGE` in `packages/router/src/oss-image.ts`, run
  `bun scripts/check-image-pin.ts` and update every drift site until green — **then**
  the cloud may offer `pseudonymize`/`noise`. Until the bump, a saved 2.2 rule
  makes the engine fail **CLOSED**: an unknown transform KIND or an unknown
  pseudonymize `kind` is rejected by the engine's zod at boot (whole DB won't
  spawn) — never a silent passthrough.
- **Two lockstep surfaces, both CI-guarded** (`bun scripts/check-mask-transforms.ts`):
  the transform-KIND list (now 7) AND the `pseudonymize`-kind set (`email`,
  `name`, `phone`) must match across cloud + engine. No DB migration for 2.2
  (new object kinds in an existing union; the jsonb column already holds them).
- **Binary-size impact:** the three compiled-in dictionaries (`~6.4 KB` of source,
  `~4 KB` of string data) added **0 bytes** to the `bun build --compile` binary
  (62,984,720 bytes with and without — the data falls within bundle-section
  alignment). Negligible; no action needed.

## Billing / pricing follow-ups

### Audit storage-pruning job (real retention, not just query-time hiding)
- **What:** A scheduled job that DELETES `audit_events_index` rows older than each
  customer's plan retention window (Free 7d / Pro 30d / Team 90d), per region.
- **Why:** The pricing PR clamps audit reads to the retention window, which closes the
  visibility/privacy gap — but old rows persist in Postgres indefinitely. "We retain
  7 days" while storing forever is a cost + compliance mismatch (raised by codex in the
  plan review).
- **Context:** PRICING.md explicitly chose "clamp at query first, prune later." The
  query clamp lives in `apps/web/src/lib/audit.ts` + `lib/connections.ts`
  (`lastQueryByDatabase`). The pruner is a separate surface: a scheduled job that runs
  per-region, deletes by `(customer_id, region, ts < now() - retention)`, and must read
  each customer's plan from the `customers.plan` column. (A background job can't use a
  request-scoped plan lookup — needing an out-of-request plan source was the original
  argument for that column, which now exists and serves exactly this.)
- **Depends on:** the pricing PR landing first (defines the windows + plan resolution).

### Fair-use soft query-rate cap (Free tier)
- **What:** A soft cap (no hard rejection) on sustained query rate for Free customers.
- **Why:** PRICING.md §Fair-use — prevent a single Free customer from driving infra cost,
  without metering real agent workflows.
- **Context:** Enforcement point is the proxy / query path (`packages/router`), not the
  dashboard caps the pricing PR touches. PRICING.md says the threshold must be calibrated
  against real usage data, which doesn't exist yet.
- **Depends on:** usage telemetry to set a defensible threshold.
