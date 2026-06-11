// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// resolvePlan() reads the active org's plan from Clerk's has() (server-side
// session claim). We mock @clerk/nextjs/server's auth() to return a has()
// that answers true for a chosen set of plan slugs, then assert the tier and
// caps fall out correctly. CAPS itself is pure and asserted directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// has() is reassigned per-test; the mock reads through the getter so each
// test can stage a different active-plan answer. Every has() param is
// recorded so a test can assert the checks are ORG-SCOPED (org:pro etc.).
let hasPredicate: (param: { plan: string }) => boolean;
let hasCalls: Array<{ plan?: string; feature?: string }>;
// auth() also yields sessionClaims, which carries the founder/internal
// override (the `planOverride` claim sourced from Clerk public metadata).
// Staged per-test; undefined = no override claim present.
let authSessionClaims: Record<string, unknown> | undefined;

const hasMock = (param: { plan: string }): boolean => {
  hasCalls.push(param);
  return hasPredicate(param);
};

vi.mock("@clerk/nextjs/server", () => ({
  get auth() {
    return async () => ({ has: hasMock, sessionClaims: authSessionClaims });
  },
}));

beforeEach(() => {
  hasPredicate = () => false; // default: no paid plan → Free
  hasCalls = [];
  authSessionClaims = undefined;
});

afterEach(() => {
  vi.resetModules();
});

/** Build a has() predicate that returns true only for the given (already
 *  org-scoped) plan slugs, e.g. hasPlans("org:pro"). */
function hasPlans(...slugs: string[]): (p: { plan: string }) => boolean {
  const set = new Set(slugs);
  return ({ plan }) => set.has(plan);
}

describe("CAPS", () => {
  it("encodes the PRICING.md tiers exactly", async () => {
    const { CAPS } = await import("../src/lib/plan.ts");
    expect(CAPS.free).toEqual({
      connections: 1,
      tokens: 5,
      auditRetentionDays: 7,
      sso: false,
    });
    expect(CAPS.pro).toEqual({
      connections: 10,
      tokens: 50,
      auditRetentionDays: 30,
      sso: false,
    });
    expect(CAPS.team).toEqual({
      connections: Infinity,
      tokens: Infinity,
      auditRetentionDays: 90,
      sso: true,
    });
  });

  it("models unlimited tiers as Infinity so `count >= cap` is never true", async () => {
    const { CAPS } = await import("../src/lib/plan.ts");
    expect(999_999 >= CAPS.team.connections).toBe(false);
    expect(999_999 >= CAPS.team.tokens).toBe(false);
  });
});

describe("resolvePlan", () => {
  it("returns team when the org team plan is active", async () => {
    hasPredicate = hasPlans("org:team");
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("returns pro when the org pro plan is active", async () => {
    hasPredicate = hasPlans("org:pro");
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("falls back to free when no paid org plan matches", async () => {
    hasPredicate = hasPlans(); // nothing active
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("prefers team over pro when (somehow) both are reported active", async () => {
    hasPredicate = hasPlans("org:team", "org:pro");
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("team");
  });

  it("checks ORG-SCOPED plan slugs (binds entitlement to the active org)", async () => {
    // Regression for the unscoped-entitlement bug: resolvePlan must ask Clerk
    // for `org:pro` / `org:team`, NOT bare `pro` / `team`. A bare slug would
    // also match a user-scoped plan (Clerk merges scopes), letting a member's
    // personal subscription unlock caps for whatever org they have active.
    hasPredicate = hasPlans(); // free; we only care about WHAT was asked
    const { resolvePlan } = await import("../src/lib/plan.ts");
    await resolvePlan();
    const planChecks = hasCalls.map((c) => c.plan);
    expect(planChecks).toContain("org:team");
    expect(planChecks).toContain("org:pro");
    // Never asks an unscoped slug (that would leak user-scoped entitlements).
    expect(planChecks).not.toContain("pro");
    expect(planChecks).not.toContain("team");
  });

  it("does NOT grant Pro for a user-scoped 'pro' plan (org scope required)", async () => {
    // A member with a personal 'pro' subscription but whose active org is on
    // Free: has({plan:'pro'}) would be true, but has({plan:'org:pro'}) is not.
    hasPredicate = hasPlans("pro"); // user-scoped only
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
  });

  it("treats an unrecognized paid org slug as free (documents the slug-set risk)", async () => {
    // A Clerk org plan whose slug isn't in PRO_SLUGS/TEAM_SLUGS resolves to
    // free. Adding a plan in Clerk requires adding `org:<slug>` to lib/plan.ts.
    hasPredicate = hasPlans("org:pro_annual");
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
  });
});

describe("resolvePlan — founder/internal override (planOverride claim)", () => {
  it("forces Team caps when the override claim is 'team', no subscription needed", async () => {
    authSessionClaims = { planOverride: "team" }; // hasPredicate → free
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("can force a LOWER tier than the subscription (test the capped UI on Pro)", async () => {
    hasPredicate = hasPlans("org:pro"); // actually on Pro
    authSessionClaims = { planOverride: "free" };
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("ignores an unknown / malformed override value (falls through to the subscription)", async () => {
    hasPredicate = hasPlans("org:pro");
    authSessionClaims = { planOverride: "enterprise" };
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("pro");
  });

  it("no override claim → resolves from the subscription as normal", async () => {
    hasPredicate = hasPlans(); // free
    authSessionClaims = undefined;
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
  });
});

describe("connectionCreateBlock", () => {
  it("returns null when both caps have room", async () => {
    const { connectionCreateBlock, CAPS } = await import("../src/lib/plan.ts");
    expect(
      connectionCreateBlock({ connections: 3, tokens: 4 }, CAPS.pro),
    ).toBeNull();
  });

  it("flags the connection cap first when it's reached", async () => {
    const { connectionCreateBlock, CAPS } = await import("../src/lib/plan.ts");
    expect(
      connectionCreateBlock({ connections: 1, tokens: 1 }, CAPS.free),
    ).toEqual({ resource: "connections", limit: 1 });
  });

  it("flags the token cap when connections have room but tokens don't", async () => {
    // Pro: 10 connections / 50 tokens. Manually minting extra tokens can
    // exhaust the token slot a new connection's default would need before
    // the connection cap is hit.
    const { connectionCreateBlock, CAPS } = await import("../src/lib/plan.ts");
    expect(
      connectionCreateBlock({ connections: 4, tokens: 50 }, CAPS.pro),
    ).toEqual({ resource: "tokens", limit: 50 });
  });

  it("never blocks on unlimited (Infinity) caps", async () => {
    const { connectionCreateBlock, CAPS } = await import("../src/lib/plan.ts");
    expect(
      connectionCreateBlock(
        { connections: 999_999, tokens: 999_999 },
        CAPS.team,
      ),
    ).toBeNull();
  });
});

describe("PlanLimitError", () => {
  it("carries resource, limit, and plan for call-site translation", async () => {
    const { PlanLimitError } = await import("../src/lib/plan.ts");
    const err = new PlanLimitError("connections", 1, "free");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlanLimitError");
    expect(err.resource).toBe("connections");
    expect(err.limit).toBe(1);
    expect(err.plan).toBe("free");
  });
});
