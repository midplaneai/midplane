// Plan resolution + numeric caps. The single entitlement chokepoint.
//
// resolvePlan() resolves the active org's tier from (in order) the self-host
// uncapped branch, the customers.plan_override manual lever, then the
// subscription-backed customers.plan written by the Stripe webhook; absent all
// three it's `free`. hasEntitlement(feature) gates ee features (e.g. "sso") on
// the ee build switch AND the resolved plan caps.
// The numeric caps below are OURS — boolean entitlements can't answer "10
// projects", so we map plan tier to caps here and count rows in Postgres
// ourselves. Callers thread `caps` down to the auth-free enforcement functions
// unchanged.
//
// Seats ARE in this map (the per-plan seat cap). They're enforced on the invite
// path via Better Auth organization.membershipLimit (lib/seats.ts) — which is
// otherwise a single static number, not per-plan.

import { UPGRADE_URL } from "./routes.ts";
import { isSelfHost } from "./self-host.ts";

// Re-exported for this module's existing server-side callers; the constant
// LIVES in routes.ts (pure) so client components can import it without
// pulling this module's graph (resolvePlan dynamically imports customer.ts,
// which reaches the Node-only db driver).
export { UPGRADE_URL };

export type Plan = "free" | "pro" | "team";

export interface PlanCaps {
  /** Max projects. Infinity = unlimited (Team). */
  projects: number;
  /** Max databases PER PROJECT (the only per-project cap — everything else
   *  counts across the customer). Bounds how far "stuff every environment
   *  into one project" can substitute for a second project; the isolation
   *  pitch (own MCP URL / policy / tokens) does the rest. Infinity = Team. */
  databases: number;
  /** Max total USABLE MCP tokens (agent identities) across all the
   *  customer's projects. The per-project default token counts.
   *  Infinity = unlimited (Team). See decision D8. */
  tokens: number;
  /** How far back /audit reads are visible, in days. This is a query-time
   *  visibility window, NOT storage deletion (old rows persist; pruning is
   *  a follow-up — see TODOS.md). */
  auditRetentionDays: number;
  /** Whether SSO/SAML is entitled. Gated on the Team plan; we gate the in-app
   *  SSO surface on this. */
  sso: boolean;
  /** Max org members (seats). Infinity = unlimited (Team). Enforced on the
   *  invite/add path via Better Auth organization.membershipLimit (see
   *  lib/seats.ts) — it's otherwise a single static number, not per-plan. */
  seats: number;
}

export const CAPS: Record<Plan, PlanCaps> = {
  // Tokens > projects on every finite tier ON PURPOSE — they are not the
  // same axis. A token IS the value metric (agents governed); a project is
  // an infra count. Two forces push the token cap above the project cap:
  //   1. Zero-downtime rotation is mint-new → cut the agent over → revoke-old,
  //      so it needs +1 usable slot over steady state. A cap of 1 made safe
  //      rotation impossible on a product whose whole pitch is credential
  //      hygiene — the N+1 floor, not a pricing lever.
  //   2. The headline demo is many agents on ONE project, each with its own
  //      identity in the audit log. With one token you cannot even show it.
  // Free stays gated on projects (1) / retention (7d) / seats (1) / SSO, so
  // a generous token count there sells the multi-agent story without
  // cannibalizing Pro.
  // Databases (per project): 2 on Free — enough to experience the multi-DB
  // tabs honestly (the one-app app-DB + analytics-DB pair) without letting a
  // whole fleet of environments ride one free project. The second PROJECT
  // stays the primary Free→Pro trigger; this cap only stops the workaround.
  // Pro gets 10 per project (mirrors the token posture: roomy enough that it
  // is never the Pro→Team forcing axis — that transition is compliance-led).
  free: {
    projects: 1,
    databases: 2,
    tokens: 5,
    auditRetentionDays: 7,
    sso: false,
    seats: 1,
  },
  pro: {
    projects: 10,
    databases: 10,
    tokens: 50,
    auditRetentionDays: 30,
    sso: false,
    seats: 10,
  },
  team: {
    projects: Infinity,
    databases: Infinity,
    tokens: Infinity,
    // Team retention EXCEEDS Pro (90 vs 30): audit history is what the
    // compliance buyer at this tier actually pays for, so the premium tier
    // must out-deliver Pro on it. Cheap to extend — retention is a query-time
    // visibility clamp, not storage deletion (old rows already persist).
    auditRetentionDays: 90,
    sso: true,
    seats: Infinity,
  },
};

/** Display-only monthly price per tier, for the /billing comparison table.
 *  NOT read by Stripe and NOT an entitlement — the authoritative price is the
 *  Stripe Price object referenced by STRIPE_{PRO,TEAM}_PRICE_ID (created by
 *  scripts/stripe-setup.ts). Keep in sync with PRICING.md and the Stripe
 *  dashboard; a mismatch here only mis-labels the table, it never changes the
 *  charge. Static (not fetched live) because the prices are flat and rarely
 *  change — avoids a Stripe round-trip on every billing page view. `period` is
 *  the trailing unit ("/mo"), empty for Free. */
export const PLAN_PRICING: Record<Plan, { amount: string; period: string }> = {
  free: { amount: "$0", period: "" },
  pro: { amount: "$49", period: "/mo" },
  team: { amount: "$399", period: "/mo" },
};

/** Uncapped self-host caps: it's your DB, your infra (the metering levers are a
 *  cloud-billing construct). Unlimited projects / tokens / seats and full
 *  audit history — auditRetentionDays = Infinity makes retentionSince() return
 *  null, so reads apply no window clamp. `sso` stays FALSE: it's ee-gated and
 *  the signed-license verifier is deferred (D3), so community runs uncapped-core
 *  with NO license check (Neosync pattern) and the ee surface stays dark.
 *  hasEntitlement("sso") reads this `sso:false`, so SSO stays dark in self-host
 *  even if MIDPLANE_EE were set. */
export const SELF_HOST_CAPS: PlanCaps = {
  projects: Infinity,
  databases: Infinity,
  tokens: Infinity,
  auditRetentionDays: Infinity,
  sso: false,
  seats: Infinity,
};

/** Thrown by createProject / createToken when a plan cap is hit. Caught
 *  at the call sites and translated to a 402 (JSON API) or inline upgrade
 *  CTA (browser forms) — never bubbles to the user as a raw 500. Mirrors
 *  the typed-error idiom (DuplicateTokenName, LastDatabaseProtected). */
export class PlanLimitError extends Error {
  constructor(
    public readonly resource: "projects" | "databases" | "tokens",
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

/** Which plan cap (if any) blocks creating ONE more project right now.
 *
 *  Pure + read-only: mirrors the order of checks inside createProject
 *  (project cap first, then the token slot the auto-minted default
 *  consumes) so a pre-flight gate renders the SAME resource the authoritative
 *  transaction would throw on. Returns null when a create would succeed.
 *
 *  This is advisory UX only — the locked count in createProject is the
 *  real enforcer and is what closes the concurrent-create race. Callers use
 *  this to hide the create form / show usage, never to skip that check. */
export function projectCreateBlock(
  usage: { projects: number; tokens: number },
  caps: PlanCaps,
): { resource: "projects" | "tokens"; limit: number } | null {
  if (usage.projects >= caps.projects) {
    return { resource: "projects", limit: caps.projects };
  }
  if (usage.tokens >= caps.tokens) {
    return { resource: "tokens", limit: caps.tokens };
  }
  return null;
}

/** Whether the project cap blocks creating ONE more project right now —
 *  the projects-only advisory twin of projectCreateBlock, for surfaces that
 *  don't mint a default token (the OAuth-first web flow) and so shouldn't
 *  factor the token slot in. Advisory UX only — createProject re-counts
 *  under the customers-row lock. */
export function projectAddBlock(
  usage: { projects: number },
  caps: PlanCaps,
): { limit: number } | null {
  if (usage.projects >= caps.projects) {
    return { limit: caps.projects };
  }
  return null;
}

/** Whether the per-project database cap blocks adding ONE more database to a
 *  project right now.
 *
 *  Advisory UX only, like the two blocks above — addDatabase re-counts the
 *  project's children under the parent row lock and is the real enforcer.
 *  Callers use this to swap the "+ Add database" affordance for the upgrade
 *  CTA, never to skip that check. Returns the cap when full, else null. */
export function databaseAddBlock(
  usage: { databases: number },
  caps: PlanCaps,
): { limit: number } | null {
  if (usage.databases >= caps.databases) {
    return { limit: caps.databases };
  }
  return null;
}

/** Whether the seat cap blocks inviting (or adding) ONE more member right now.
 *
 *  Counts current members PLUS pending invites against the plan's seat cap, so a
 *  Free org (cap 1 = owner only) can't stockpile pending invites that would
 *  over-subscribe the cap. Advisory UX only — Better Auth's
 *  organization.membershipLimit (lib/seats.ts) is the real enforcer on the
 *  invite/accept path. Returns the cap when full, else null (a create would
 *  succeed). Mirrors projectCreateBlock. */
export function seatInviteBlock(
  usage: { members: number; pending: number },
  caps: PlanCaps,
): { limit: number } | null {
  if (usage.members + usage.pending >= caps.seats) {
    return { limit: caps.seats };
  }
  return null;
}

/** JSON body for a 402 Payment Required when a plan cap is hit (decision D5).
 *  Shared by POST /api/projects and POST /api/projects/[id]/tokens so
 *  the machine-readable shape is identical on both routes. */
export function planLimitBody(err: PlanLimitError): {
  error: "plan_limit";
  resource: "projects" | "databases" | "tokens";
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

/** Resolve the active organization's plan + caps.
 *
 *  Read order: self-host (uncapped, before any DB read) → customers.plan_override
 *  (the manual lever, BEATS the subscription) → customers.plan (subscription-
 *  backed, written by the Stripe webhook) → `free`. Kept async + called once per
 *  request so callers thread `caps` down to the auth-free, unit-tested lib
 *  enforcement functions unchanged. We never clawback already-created resources
 *  on a downgrade; only new creates are gated.
 *
 *  Dynamic import keeps the top of this module dependency-free so the pure
 *  exports (CAPS, PlanLimitError, types) stay importable by tokens.ts /
 *  projects.ts + their unit tests without pulling auth/db into those paths. */
export async function resolvePlan(): Promise<ResolvedPlan> {
  // Self-host is uncapped core. Returned before any DB read — keeps this the
  // single entitlement seam without pulling customer.ts into the self-host
  // path. Label as the closest existing tier ("team") for any UI that switches
  // on plan; ee features stay gated via hasEntitlement().
  if (isSelfHost()) {
    return { plan: "team", caps: SELF_HOST_CAPS };
  }
  const { currentCustomer } = await import("./customer.ts");
  const customer = await currentCustomer();
  return resolvePlanFor(customer);
}

/** Resolve plan + caps from a customer row already in hand — the sync twin
 *  of resolvePlan() for callers whose caller resolved the customer (server
 *  actions receive it as a parameter), so enforcement doesn't re-resolve the
 *  session and re-read the customers row per submit. Same order: self-host
 *  (uncapped) → plan_override (the manual lever, BEATS the subscription) →
 *  subscription-backed plan → free. */
export function resolvePlanFor(
  customer: { plan?: Plan | null; planOverride?: Plan | null } | null,
): ResolvedPlan {
  if (isSelfHost()) {
    return { plan: "team", caps: SELF_HOST_CAPS };
  }
  const plan: Plan = customer?.planOverride ?? customer?.plan ?? "free";
  return { plan, caps: CAPS[plan] };
}

/** App-level boolean entitlement features. Add a key here as each ee feature
 *  lands; hasEntitlement() maps it to the entitlement source so callers never
 *  hit the auth/billing SDK directly. */
export type EntitlementFeature = "sso";

/** Whether THIS build ships + activates the Enterprise Edition (ee/). The
 *  core-readable mirror of ee/index.ts's eeEnabled() (canonical there): core may
 *  not import ee/, so the MIDPLANE_EE read is duplicated here for the one place
 *  core gates on the build switch — the entitlement chokepoint below, and the
 *  pre-auth sign-in surface, which has no org context to resolve a plan from. */
export function eeBuildEnabled(): boolean {
  return process.env.MIDPLANE_EE === "1";
}

/** Whether the active org is entitled to a boolean feature. The single
 *  feature-gating seam — callers go through this, never the auth/billing SDK.
 *
 *  An ee feature needs BOTH gates: the build SWITCH (MIDPLANE_EE — the ee bundle
 *  is present + licensed) AND the per-org plan ENTITLEMENT (caps). Self-host
 *  resolves to SELF_HOST_CAPS (sso:false), so ee stays dark there regardless of
 *  the flag; keyless cloud fails the build switch; only a licensed cloud build on
 *  the Team plan returns true. Fails closed on every other path. */
export async function hasEntitlement(
  feature: EntitlementFeature,
): Promise<boolean> {
  if (!eeBuildEnabled()) return false;
  const { caps } = await resolvePlan();
  switch (feature) {
    case "sso":
      return caps.sso;
    default:
      return false;
  }
}
