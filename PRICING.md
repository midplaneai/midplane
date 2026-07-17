# Pricing — Midplane Cloud

Implemented and live on the hosted product. Billing runs on the **@better-auth/stripe plugin** (a customer == an organization); each org's plan is persisted to the `customers.plan` column, written by the plugin's Stripe webhook and read per-request by `resolvePlan()`. Pricing is **flat per org** — one monthly price per tier, independent of member count. The numeric caps below live in the `CAPS` map in `apps/web/src/lib/plan.ts` — this doc is the rationale of record, so keep the two in sync.

## Principles

1. **Structural limits, not volume.** Counting queries doesn't bind on real agent usage — an agent reasons between calls, so a heavy individual does ~15k queries/mo and a 5-person team does ~75k/mo. Volume gates would only trigger for customers already big enough to be paying for other reasons. Gate on the things that scale with the customer's actual use of the product: projects, machine tokens (headless credentials), and teammates. Interactive agents (OAuth clients a person signs into — Claude, Cursor, ChatGPT) are the adoption surface, not a metered resource: connect as many as you want on every tier.
2. **Don't paywall the core.** Policy enforcement, audit logging, and credential isolation are the product. They're available on every tier. Tiers differ in how much of each you get and which compliance affordances are wired up.
3. **No vaporware in the matrix.** If it isn't shipped, it isn't a row. Custom asks (BYOK, SAML, dedicated region, custom retention) go through a "talk to us" path until they're built and sold.
4. **Each tier transition has two triggers.** A volume reason ("we grew") and a feature reason ("compliance asked"). Either alone closes a deal; together they close it faster.

## Tiers

| | Free | Pro | Team |
|---|---|---|---|
| **Price** | $0 | **$49/mo** | **$399/mo** |
| Projects | 1 | 10 | unlimited |
| Interactive agents (Claude, Cursor, ChatGPT) | unlimited | unlimited | unlimited |
| Machine tokens (CI, backend, headless) | 5 | 50 | unlimited |
| Seats | 1 | 10 | unlimited |
| Audit retention | 7 days | 30 days | 90 days |
| Policy engine (allow/deny/warn) | ✓ | ✓ | ✓ |
| Per-table access + tenant scope (parser-level) | ✓ | ✓ | ✓ |
| Dangerous-statement guardrails (DML with no WHERE; DROP / TRUNCATE / ALTER) | ✓ | ✓ | ✓ |
| SSO / SAML | — | — | ✓ |
| Support | community | email | priority email |

**Custom needs (BYOK, SAML, custom retention, dedicated region, SOC2/HIPAA artifacts, SLA): contact us.**

## Upgrade triggers

- **Free → Pro**: the second of anything — second project or second teammate. Or "I need to see last week's audit log." (Interactive agents don't factor in — they're unlimited on Free.)
- **Pro → Team**: SSO ask from the security team, longer audit retention (90 days vs Pro's 30), or outgrowing Pro's caps on projects, machine tokens, or seats.
- **Team → custom**: BYOK requirement, dedicated region, SOC2/HIPAA artifact request, or any contract clause that doesn't fit the standard plan.

The Pro → Team transition is intentionally a *compliance/team-process* moment, not a counter incrementing. SSO is the canonical trigger.

## Why these numbers

**Free: 1 project / unlimited interactive agents / 5 machine tokens / 1 seat.** The binding walls are project (1), retention (7 days), seat (1), and SSO — the moments a customer feels anyway (their second project, their second teammate, their security team's first ask). Neither agents nor machine tokens is one of those walls. The headline demo — many agents on one project, each with its own row in the audit log — runs on interactive agents, which are unlimited on every tier, so the free tier tells that story in full. Machine tokens (static credentials for headless automation) get 5: enough to wire a couple of backend services and still hold a spare slot for zero-downtime rotation (mint-new → cut over → revoke-old). Projects, retention, seats, and SSO still gate the upgrade.

**Databases per project: a fixed 10 on every plan** (unlimited only on self-host). Deliberately *not* a tier lever, so it's absent from the table above — it's a structural ceiling, identical on Free, Pro, and Team. Adding a database spawns no new container: all of a project's databases share one per-project engine machine, so database *count* carries no compute cost and has no business being a paid axis. The ceiling only bounds the per-DB machinery that does grow with it — a KMS key, an encrypted DSN, an indexer cursor, scope grants, policy-YAML size, plus the OAuth consent screen and the database-strip tabs. Ten clears every realistic single-project shape (app DB + analytics + replica + a couple service DBs); past it, the isolation model wants a second project (its own MCP URL / policy / tokens), not a wider one. At the ceiling the UI points to "create another project," never an upgrade — upgrading wouldn't raise it.

**Pro: 10 projects / 50 machine tokens / 10 seats at $49/mo** sits in the middle of the dev-infra Pro band. Machine tokens run 5× the project count because a project often has several backend services wired to it — and the machine-token cap should never be the thing that forces a Pro→Team upgrade (that's a capability/compliance moment, not a counter). Comparables:

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

**Unlimited Team at $399/mo** sits on the lower end of the dev-infra Team band (Sentry Business $80, Langfuse Team $499, Supabase Team $599). Conservative for a newer product; leaves room to raise once SSO + RBAC are battle-tested. Team also triples audit retention over Pro (90 days vs 30) — the premium tier has to out-deliver Pro on the exact axis the compliance buyer is paying for, and extending it is nearly free since retention is a query-time visibility clamp, not storage (the rows already persist; pruning is a separate, later decision).

## What we deliberately did not gate

- **Interactive agents.** Connect as many OAuth clients (Claude, Cursor, ChatGPT) as you want on any tier. An agent is the adoption surface, not a metered resource, and capping it would fight the product's own least-privilege story — a cap nudges credential sharing, the exact thing the product exists to prevent. Only headless machine tokens count.
- **Query volume.** Agent traffic doesn't bind on volume at any realistic individual or small-team scale. Keeping queries unmetered (subject to a fair-use abuse cap) avoids training customers that midplane is a metering product when it's actually a safety product.
- **Regions.** Pick eu or us at signup; both are available to everyone. Active-active across both regions is a custom ask.
- **Audit log export.** CSV/JSON export of the filtered log is on every tier, clamped to the tier's retention window — exporting your own audit trail isn't a paywall. Streaming/SIEM delivery (S3 / Datadog / Splunk webhooks) isn't built yet; it slots into Team when it lands.
- **Policy expressiveness.** Same engine across tiers. Hiding policy features behind a paywall hides the product.
- **RBAC beyond the org plugin's default `owner`/`admin`/`member`.** Custom role layers (policy editor vs. viewer, audit reader, project admin) don't exist yet. Slots into Team when built.

## Fair-use cap

To prevent a single free customer from driving infrastructure cost, the free tier has a soft cap (no hard rejection) on sustained query rate. The number is set high enough that real agent workflows never hit it. Calibrate against actual usage data once the cap exists.

## Implementation (as built)

- **`customers.plan` is the entitlement source of truth.** A text enum (`free` | `pro` | `team`) on the `customers` row, written ONLY by the @better-auth/stripe plugin's subscription-lifecycle hooks — the plugin owns `/api/auth/stripe/webhook` (signature-verified), and `resolvePlan()` (`apps/web/src/lib/plan.ts`) reads the column per-request, defaulting to Free. The status→tier map is pure (`planFromSubscription`): `active` / `trialing` grant the tier, everything else (`past_due`, `canceled`, `unpaid`, `incomplete`, `paused`) → Free, so a replayed webhook is a no-op. Pricing is **flat per org**: each tier is a plain Stripe `priceId` (no `seatPriceId`), billed as one fixed-quantity-1 subscription per org regardless of member count; self-serve Checkout + the Customer Portal are the plugin's hosted surfaces, so we wire no custom checkout UI.
- **Caps are a code map, not data.** `CAPS` in `plan.ts` maps each tier → `{ projects, tokens, auditRetentionDays, sso, seats }`. The subscription only resolves the tier — "10 projects" isn't something Stripe can answer — so we map tier → caps here and count rows in Postgres ourselves.
- **Enforcement points.** Project create and machine-token mint each take a `SELECT … FOR UPDATE` on the `customers` row, then count usable rows under that lock (race-safe), throwing `PlanLimitError` over-cap. Only `kind='url'` machine tokens count (`countUsableTokens`); interactive-agent (OAuth) rows mint through a separate, uncapped path, so connecting an agent never trips the cap. `PlanLimitError` surfaces as a **402** `{error:'plan_limit',…}` on the JSON API and an inline upgrade CTA on browser forms. A pure pre-flight layer (`projectCreateBlock` + `getPlanUsage`) hides doomed forms and shows `N / M` usage, but never replaces the locked check.
- **Database add is separate — a structural cap, not a plan lever.** It locks the parent *project* row and counts siblings under that lock against the fixed `MAX_DATABASES_PER_PROJECT` (10, plan-independent; Infinity on self-host), throwing `DatabaseLimitError` over the ceiling. Because the ceiling is identical on every plan, this is **not** a 402 and **not** an upgrade prompt: the pre-flight twin `databaseAddBlock` swaps the "+ Add database" affordance for a *"create another project"* link, and the server action renders the same structural message on a race.
- **Seats are our membership cap, not a billing metric.** `CAPS.seats` (1 / 10 / ∞) bounds org members per tier, enforced on the invite/accept path via Better Auth `organization.membershipLimit` → `seatCapForOrg` (`lib/seats.ts`). It's fully decoupled from Stripe — the price is flat per org, so the cap only limits head count; it never changes the bill. (Going per-seat later is one field: re-add `seatPriceId` to the plan config.)
- **Audit retention is a query-time visibility clamp, not storage deletion.** The `lib/audit.ts` read helpers (and `lib/projects.ts` last-query freshness) take a `retentionDays` and clamp the `since` bound to the tier window. Old rows persist; storage pruning is a follow-up in `TODOS.md`.
- **Founder / internal override is the `customers.plan_override` column, not an env var.** `resolvePlan()` reads `plan_override` (set it to `free` / `pro` / `team`); a valid value BEATS the subscription-backed `plan` in either direction — force `team` to test unlimited, or `free` to exercise the capped UI on a paying account.
- **Enterprise contact path** is `mailto:info@midplane.ai?subject=Enterprise` on the landing-page Enterprise card; the in-app `/billing` Enterprise card offers sales@midplane.ai plus a [book-a-call link](https://calendar.app.google/NaSZgsxq9ptBYrLy6). No forms.

## Still TODO (not yet a row, per principle 3)

Audit-log storage pruning, the free-tier fair-use query cap, SIEM/streaming export (S3 / Datadog / Splunk), and RBAC layers beyond the org plugin's default `owner` / `admin` / `member`. Each slots into its tier when built and sold — until then it stays in the "contact us" path, not the matrix.
