# TODOS — midplane-cloud

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Connections / test-surface follow-ups

### Live E2E flows for the policy test surface (P1 — deferred from plan)
- **What:** Three live E2E specs: (1) new connection → DSN test fails → fix → create;
  (2) connection home → run probes → deny rows render with reasons; (3) edit a table
  policy → re-run probes → verdict reflects the change (exercises push-then-probe).
- **Why:** These are the design doc's success criteria for the trust surface; every
  layer beneath them is unit/route-tested, but nothing walks the real pipe end to end.
- **Context:** Needs engine 0.8.0 (`bun run dev:image` or the published image) + an
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
