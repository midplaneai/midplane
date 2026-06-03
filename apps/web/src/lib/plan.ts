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
  free: { connections: 1, tokens: 1, auditRetentionDays: 7, sso: false },
  pro: { connections: 10, tokens: 10, auditRetentionDays: 30, sso: false },
  team: {
    connections: Infinity,
    tokens: Infinity,
    auditRetentionDays: 30,
    sso: true,
  },
};

// Clerk plan slugs that map to each paid tier. Kept as sets so adding an
// annual / grandfathered SKU later (e.g. "pro_annual") is a one-line change
// here — NOT a schema migration. IMPORTANT: every paid Clerk plan slug must
// appear in exactly one of these sets, or resolvePlan() will silently treat
// a paying org as Free. When you add a plan in the Clerk dashboard, add its
// slug here (same discipline as the OSS image pin sites in CLAUDE.md).
const TEAM_SLUGS = ["team"] as const;
const PRO_SLUGS = ["pro"] as const;

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
  const { has } = await auth();
  if (TEAM_SLUGS.some((slug) => has({ plan: slug }))) {
    return { plan: "team", caps: CAPS.team };
  }
  if (PRO_SLUGS.some((slug) => has({ plan: slug }))) {
    return { plan: "pro", caps: CAPS.pro };
  }
  return { plan: "free", caps: CAPS.free };
}
