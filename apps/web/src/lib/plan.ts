// Plan resolution for Clerk-Billing-on-Organizations pricing.
//
// Source of truth is Clerk: the org's active subscription is read LIVE via
// auth().has({ plan }) — no customers.plan column, no webhook (see the
// pricing plan review, decision D2). The numeric caps below are OURS: Clerk
// features are boolean entitlements, so "10 connections" is not something
// Clerk can answer — we map the plan tier to caps here and count rows in
// Postgres ourselves.
//
// Seats are NOT in this map: Clerk's seat-limit plans enforce per-org member
// caps natively (dashboard config sets max_allowed_memberships; Clerk blocks
// new members at the limit). We add zero seat-enforcement code.

export type Plan = "free" | "pro" | "team";

export interface PlanCaps {
  /** Max connections. Infinity = unlimited (Team). */
  connections: number;
  /** Max total USABLE MCP tokens (agent identities) across all the
   *  customer's connections. The per-connection default token counts.
   *  Infinity = unlimited (Team). See decision D8. */
  tokens: number;
  /** How far back /audit reads are visible, in days. This is a query-time
   *  visibility window, NOT storage deletion (old rows persist; pruning is
   *  a follow-up — see TODOS.md). */
  auditRetentionDays: number;
  /** Whether SSO/SAML is entitled. Mirrors a Clerk `sso` feature on the
   *  Team plan; we gate the in-app SSO surface on this. */
  sso: boolean;
}

export const CAPS: Record<Plan, PlanCaps> = {
  // Tokens > connections on every finite tier ON PURPOSE — they are not the
  // same axis. A token IS the value metric (agents governed); a connection is
  // an infra count. Two forces push the token cap above the connection cap:
  //   1. Zero-downtime rotation is mint-new → cut the agent over → revoke-old,
  //      so it needs +1 usable slot over steady state. A cap of 1 made safe
  //      rotation impossible on a product whose whole pitch is credential
  //      hygiene — the N+1 floor, not a pricing lever.
  //   2. The headline demo is many agents on ONE connection, each with its own
  //      identity in the audit log. With one token you cannot even show it.
  // Free stays gated on connections (1) / retention (7d) / SSO, so a generous
  // token count there sells the multi-agent story without cannibalizing Pro.
  free: { connections: 1, tokens: 5, auditRetentionDays: 7, sso: false },
  pro: { connections: 10, tokens: 50, auditRetentionDays: 30, sso: false },
  team: {
    connections: Infinity,
    tokens: Infinity,
    // Team retention EXCEEDS Pro (90 vs 30): audit history is what the
    // compliance buyer at this tier actually pays for, so the premium tier
    // must out-deliver Pro on it. Cheap to extend — retention is a query-time
    // visibility clamp, not storage deletion (old rows already persist).
    auditRetentionDays: 90,
    sso: true,
  },
};

// Clerk plan slugs that map to each paid tier, ORG-SCOPED.
//
// The `org:` prefix binds the entitlement to the ACTIVE ORGANIZATION. Without
// it, has({ plan: 'pro' }) matches a user-scoped OR org-scoped plan with that
// slug (Clerk merges both scopes — see @clerk/shared authorization.ts
// checkForFeatureOrPlan): a member who personally subscribed to a 'pro' plan
// would wrongly unlock Pro caps for whatever org they have active. `org:pro`
// checks only the org's subscription. The dashboard plan slug stays `pro`;
// `org:` is the scope, parsed off before the lookup.
//
// Kept as sets so adding an annual / grandfathered SKU later (e.g.
// "org:pro_annual") is a one-line change here — NOT a schema migration.
// IMPORTANT: every paid Clerk plan slug must appear (org-scoped) in exactly
// one set, or resolvePlan() silently treats a paying org as Free. When you
// add an org plan in the Clerk dashboard, add `org:<slug>` here (same
// discipline as the OSS image pin sites in CLAUDE.md).
const TEAM_SLUGS = ["org:team"] as const;
const PRO_SLUGS = ["org:pro"] as const;

/** Thrown by createConnection / createToken when a plan cap is hit. Caught
 *  at the call sites and translated to a 402 (JSON API) or inline upgrade
 *  CTA (browser forms) — never bubbles to the user as a raw 500. Mirrors
 *  the typed-error idiom (DuplicateTokenName, LastDatabaseProtected). */
export class PlanLimitError extends Error {
  constructor(
    public readonly resource: "connections" | "tokens",
    public readonly limit: number,
    public readonly plan: Plan,
  ) {
    super(`plan limit reached: ${resource} (limit ${limit}) on plan ${plan}`);
    this.name = "PlanLimitError";
  }
}

export interface ResolvedPlan {
  plan: Plan;
  caps: PlanCaps;
}

// Founder / internal plan override, read from the active org's (or user's)
// Clerk PUBLIC METADATA surfaced into the session token as a `planOverride`
// claim. Editable straight from the Clerk dashboard — no env var, no org-id
// list to keep in sync, no customers.plan column (decision D2 stays intact),
// and no network round-trip (it rides the JWT exactly like has()).
//
// One-time setup — Clerk dashboard → Sessions → Customize session token:
//   { "planOverride": "{{org.public_metadata.plan_override}}" }
// (swap `org` for `user` to flag a person regardless of the active org).
// Then set that org's / user's public metadata to { "plan_override": "team" }.
//
// A valid slug here OVERRIDES the subscription, in either direction: set
// "team" to test without limits, or "free"/"pro" to exercise the capped UI
// on an account that actually pays for more. Anything else is ignored.
function planFromOverrideClaim(value: unknown): Plan | null {
  return value === "free" || value === "pro" || value === "team"
    ? value
    : null;
}

/** Which plan cap (if any) blocks creating ONE more connection right now.
 *
 *  Pure + read-only: mirrors the order of checks inside createConnection
 *  (connection cap first, then the token slot the auto-minted default
 *  consumes) so a pre-flight gate renders the SAME resource the authoritative
 *  transaction would throw on. Returns null when a create would succeed.
 *
 *  This is advisory UX only — the locked count in createConnection is the
 *  real enforcer and is what closes the concurrent-create race. Callers use
 *  this to hide the create form / show usage, never to skip that check. */
export function connectionCreateBlock(
  usage: { connections: number; tokens: number },
  caps: PlanCaps,
): { resource: "connections" | "tokens"; limit: number } | null {
  if (usage.connections >= caps.connections) {
    return { resource: "connections", limit: caps.connections };
  }
  if (usage.tokens >= caps.tokens) {
    return { resource: "tokens", limit: caps.tokens };
  }
  return null;
}

/** Where a capped user goes to upgrade. Relative so it resolves on whichever
 *  regional host served the request. */
export const UPGRADE_URL = "/billing";

/** JSON body for a 402 Payment Required when a plan cap is hit (decision D5).
 *  Shared by POST /api/connections and POST /api/connections/[id]/tokens so
 *  the machine-readable shape is identical on both routes. */
export function planLimitBody(err: PlanLimitError): {
  error: "plan_limit";
  resource: "connections" | "tokens";
  limit: number;
  plan: Plan;
  upgradeUrl: string;
} {
  return {
    error: "plan_limit",
    resource: err.resource,
    limit: err.limit,
    plan: err.plan,
    upgradeUrl: UPGRADE_URL,
  };
}

/** Resolve the active organization's plan from the Clerk session, LIVE.
 *
 *  Reads the session JWT claim via has() — no DB or network round-trip.
 *  Plan changes propagate on the next token refresh (Clerk refreshes ~60s;
 *  billing downgrades apply at cycle end). We do not clawback already-
 *  created resources on downgrade — only new creates are gated. Defaults to
 *  Free when no paid slug matches (including no active org).
 *
 *  Call once per request and thread `caps` down to the lib enforcement
 *  functions, which stay Clerk-free and unit-testable. */
export async function resolvePlan(): Promise<ResolvedPlan> {
  // Dynamic import keeps the top of this module Clerk-free, so the pure
  // exports (CAPS, PlanLimitError, types) can be imported by the lib
  // enforcement functions (tokens.ts / connections.ts) and their unit
  // tests without pulling @clerk/nextjs/server into those paths. Mirrors
  // the dynamic-import pattern in clerk-users.ts / customer.ts.
  const { auth } = await import("@clerk/nextjs/server");
  const { has, sessionClaims } = await auth();
  // Founder / internal override first — a planOverride claim (sourced from
  // Clerk public metadata) wins over the subscription, so it applies even
  // when no paid plan is attached and can also force a LOWER tier for
  // testing the capped UI.
  const override = planFromOverrideClaim(
    (sessionClaims as { planOverride?: unknown } | null)?.planOverride,
  );
  if (override) {
    return { plan: override, caps: CAPS[override] };
  }
  if (TEAM_SLUGS.some((slug) => has({ plan: slug }))) {
    return { plan: "team", caps: CAPS.team };
  }
  if (PRO_SLUGS.some((slug) => has({ plan: slug }))) {
    return { plan: "pro", caps: CAPS.pro };
  }
  return { plan: "free", caps: CAPS.free };
}

/** App-level boolean entitlement features. Add a key here as each ee feature
 *  lands; hasEntitlement() maps it to the provider check so callers never hit
 *  the auth SDK directly. */
export type EntitlementFeature = "sso";

// Our feature key -> ORG-SCOPED Clerk feature slug. The `org:` prefix binds the
// check to the ACTIVE org's subscription; an unscoped `sso` would also match a
// user-scoped feature (Clerk merges both scopes) and wrongly entitle the org.
const CLERK_FEATURE_SLUG: Record<EntitlementFeature, string> = {
  sso: "org:sso",
};

/** Whether the active org is entitled to a boolean feature, LIVE from the
 *  session JWT (no DB round-trip). The single feature-gating seam: P2 swaps
 *  this body from Clerk to Better Auth in ONE place; callers use
 *  hasEntitlement(feature), never has() directly. Behavior-preserving — the
 *  same org-scoped check the billing page did inline. */
export async function hasEntitlement(
  feature: EntitlementFeature,
): Promise<boolean> {
  const { auth } = await import("@clerk/nextjs/server");
  const { has } = await auth();
  return has({ feature: CLERK_FEATURE_SLUG[feature] });
}
