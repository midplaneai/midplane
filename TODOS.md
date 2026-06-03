# TODOS — midplane-cloud

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Billing / pricing follow-ups

### Audit storage-pruning job (real retention, not just query-time hiding)
- **What:** A scheduled job that DELETES `audit_events_index` rows older than each
  customer's plan retention window (Free 7d / Pro 30d / Team 30d), per region.
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
