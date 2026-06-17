// Plan resolution + numeric caps. The single entitlement chokepoint.
//
// resolvePlan() resolves the active org's tier from (in order) the self-host
// uncapped branch, the customers.plan_override manual lever, then the
// subscription-backed customers.plan written by the Stripe webhook; absent all
// three it's `free`. hasEntitlement(feature) gates ee features (e.g. "sso") on
// the ee build switch AND the resolved plan caps.
// The numeric caps below are OURS — boolean entitlements can't answer "10
// connections", so we map plan tier to caps here and count rows in Postgres
// ourselves. Callers thread `caps` down to the auth-free enforcement functions
// unchanged.
//
// Seats ARE in this map (the per-plan seat cap). They're enforced on the invite
// path via Better Auth organization.membershipLimit (lib/seats.ts) — which is
// otherwise a single static number, not per-plan.

import { isSelfHost } from "./self-host.ts";

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
  /** Whether SSO/SAML is entitled. Gated on the Team plan; we gate the in-app
   *  SSO surface on this. */
  sso: boolean;
  /** Max org members (seats). Infinity = unlimited (Team). Enforced on the
   *  invite/add path via Better Auth organization.membershipLimit (see
   *  lib/seats.ts) — it's otherwise a single static number, not per-plan. */
  seats: number;
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
  // Free stays gated on connections (1) / retention (7d) / seats (1) / SSO, so
  // a generous token count there sells the multi-agent story without
  // cannibalizing Pro.
  free: { connections: 1, tokens: 5, auditRetentionDays: 7, sso: false, seats: 1 },
  pro: { connections: 10, tokens: 50, auditRetentionDays: 30, sso: false, seats: 10 },
  team: {
    connections: Infinity,
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

/** Uncapped self-host caps: it's your DB, your infra (the metering levers are a
 *  cloud-billing construct). Unlimited connections / tokens / seats and full
 *  audit history — auditRetentionDays = Infinity makes retentionSince() return
 *  null, so reads apply no window clamp. `sso` stays FALSE: it's ee-gated and
 *  the signed-license verifier is deferred (D3), so community runs uncapped-core
 *  with NO license check (Neosync pattern) and the ee surface stays dark.
 *  hasEntitlement("sso") reads this `sso:false`, so SSO stays dark in self-host
 *  even if MIDPLANE_EE were set. */
export const SELF_HOST_CAPS: PlanCaps = {
  connections: Infinity,
  tokens: Infinity,
  auditRetentionDays: Infinity,
  sso: false,
  seats: Infinity,
};

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
 *  connections.ts + their unit tests without pulling auth/db into those paths. */
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
  // plan_override is the manual lever and wins over the subscription; absent it,
  // the subscription-backed plan applies; absent a customer row, free.
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
