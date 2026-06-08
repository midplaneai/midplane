# Pricing — Midplane Cloud

Draft tier structure. Not yet implemented (no `plan` column, no Stripe wiring). This doc is the design target before any billing code lands.

## Principles

1. **Structural limits, not volume.** Counting queries doesn't bind on real agent usage — an agent reasons between calls, so a heavy individual does ~15k queries/mo and a 5-person team does ~75k/mo. Volume gates would only trigger for customers already big enough to be paying for other reasons. Gate on the things that scale with the customer's actual use of the product: connections, agent identities, teammates.
2. **Don't paywall the core.** Policy enforcement, audit logging, and credential isolation are the product. They're available on every tier. Tiers differ in how much of each you get and which compliance affordances are wired up.
3. **No vaporware in the matrix.** If it isn't shipped, it isn't a row. Custom asks (BYOK, SAML, dedicated region, custom retention) go through a "talk to us" path until they're built and sold.
4. **Each tier transition has two triggers.** A volume reason ("we grew") and a feature reason ("compliance asked"). Either alone closes a deal; together they close it faster.

## Tiers

| | Free | Pro | Team |
|---|---|---|---|
| **Price** | $0 | **$49/mo** | **$399/mo** |
| Connections | 1 | 10 | unlimited |
| MCP tokens | 1 | 10 | unlimited |
| Seats | 1 | 10 | unlimited |
| Audit retention | 7 days | 30 days | 30 days |
| Policy engine (allow/deny/warn) | ✓ | ✓ | ✓ |
| Per-table access + tenant scope (parser-level) | ✓ | ✓ | ✓ |
| SSO / SAML | — | — | ✓ |
| Support | community | email | priority email |

**Custom needs (BYOK, SAML, custom retention, dedicated region, SOC2/HIPAA artifacts, SLA): contact us.**

## Upgrade triggers

- **Free → Pro**: the second of anything — second app, second agent identity, second teammate. Or "I need to see last week's audit log."
- **Pro → Team**: SSO ask from the security team, or outgrowing Pro's 10-unit caps on connections, tokens, or seats. Longer retention is an Enterprise ask.
- **Team → custom**: BYOK requirement, dedicated region, SOC2/HIPAA artifact request, or any contract clause that doesn't fit the standard plan.

The Pro → Team transition is intentionally a *compliance/team-process* moment, not a counter incrementing. SSO is the canonical trigger.

## Why these numbers

**1/1/1 free** matches Neon, PlanetScale, Clerk, and LangSmith. Every additional unit creates upgrade pressure on a moment the customer would feel anyway (adding their second app, inviting their second teammate). It's tight but defensible because the policy engine — the product's headline value — demonstrates fully on a single connection.

**10/10/10 Pro at $49/mo** sits in the middle of the dev-infra Pro band. Comparables:

| Product | Pro / mo |
|---|---|
| Sentry Team | $26 |
| Supabase Pro | $25 / project |
| Neon Launch | $19 |
| Clerk Pro | $25 + per-MAU |
| PlanetScale Scaler | $39 |
| LangSmith Plus | $39 + overage |
| Langfuse Core | $59 |
| Helicone Growth | $80 |

$29 reads "hobby-tier" for a compliance-positioned product; the indie/post-MVP buyer pays $20–40 each for Vercel, Sentry, Clerk, PlanetScale without flinching. $49 is in the swimlane.

**Unlimited Team at $399/mo** sits on the lower end of the dev-infra Team band (Sentry Business $80, Langfuse Team $499, Supabase Team $599). Conservative for a newer product; leaves room to raise once SSO + RBAC are battle-tested.

## What we deliberately did not gate

- **Query volume.** Agent traffic doesn't bind on volume at any realistic individual or small-team scale. Keeping queries unmetered (subject to a fair-use abuse cap) avoids training customers that midplane is a metering product when it's actually a safety product.
- **Regions.** Pick eu or us at signup; both are available to everyone. Active-active across both regions is a custom ask.
- **Audit log export.** CSV/JSON export of the filtered log is on every tier, clamped to the tier's retention window — exporting your own audit trail isn't a paywall. Streaming/SIEM delivery (S3 / Datadog / Splunk webhooks) isn't built yet; it slots into Team when it lands.
- **Policy expressiveness.** Same engine across tiers. Hiding policy features behind a paywall hides the product.
- **RBAC beyond Clerk's default `admin`/`member`.** Custom role layers (policy editor vs. viewer, audit reader, connection admin) don't exist yet. Slots into Team when built.

## Fair-use cap

To prevent a single free customer from driving infrastructure cost, the free tier has a soft cap (no hard rejection) on sustained query rate. The number is set high enough that real agent workflows never hit it. Calibrate against actual usage data once the cap exists.

## Implementation notes (for the eventual billing PR)

- Add a `plan` enum column to `customers` in `packages/db/src/schema.ts`: `free | pro | team`.
- Enforcement points: connection creation (count check), MCP token mint (count check), org seat invite (count check), audit log query (retention window).
- Clerk Billing (already partially wired per `apps/web/src/lib/customer.ts`) handles the payment surface. Map Stripe products → `plan` enum on webhook.
- Retention enforcement: `audit_events_index` query helpers must accept and clamp a `since` argument to the customer's tier window. Storage retention (vs. query-time clamping) is a separate decision — clamp at query first, prune later.
- "Talk to us" footer link: `mailto:sales@midplane.ai` or a Cal.com link, not a TypeForm.
