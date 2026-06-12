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
  each customer's plan (via Clerk `has()` is request-context only — the job needs a
  plan source, which is the first reason a `customers.plan` column might earn its place).
- **Depends on:** the pricing PR landing first (defines the windows + plan resolution).

### Fair-use soft query-rate cap (Free tier)
- **What:** A soft cap (no hard rejection) on sustained query rate for Free customers.
- **Why:** PRICING.md §Fair-use — prevent a single Free customer from driving infra cost,
  without metering real agent workflows.
- **Context:** Enforcement point is the proxy / query path (`packages/router`), not the
  dashboard caps the pricing PR touches. PRICING.md says the threshold must be calibrated
  against real usage data, which doesn't exist yet.
- **Depends on:** usage telemetry to set a defensible threshold.
