// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// resolvePlan() reads the active org's plan from Clerk's has() (server-side
// session claim). We mock @clerk/nextjs/server's auth() to return a has()
// that answers true for a chosen set of plan slugs, then assert the tier and
// caps fall out correctly. CAPS itself is pure and asserted directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// has() is reassigned per-test; the mock reads through the getter so each
// test can stage a different active-plan answer.
let hasMock: (param: { plan: string }) => boolean;

vi.mock("@clerk/nextjs/server", () => ({
  get auth() {
    return async () => ({ has: hasMock });
  },
}));

beforeEach(() => {
  hasMock = () => false; // default: no paid plan → Free
});

afterEach(() => {
  vi.resetModules();
});

/** Build a has() that returns true only for the given plan slugs. */
function hasPlans(...slugs: string[]): (p: { plan: string }) => boolean {
  const set = new Set(slugs);
  return ({ plan }) => set.has(plan);
}

describe("CAPS", () => {
  it("encodes the PRICING.md tiers exactly", async () => {
    const { CAPS } = await import("../src/lib/plan.ts");
    expect(CAPS.free).toEqual({
      connections: 1,
      tokens: 1,
      auditRetentionDays: 7,
      sso: false,
    });
    expect(CAPS.pro).toEqual({
      connections: 10,
      tokens: 10,
      auditRetentionDays: 30,
      sso: false,
    });
    expect(CAPS.team).toEqual({
      connections: Infinity,
      tokens: Infinity,
      auditRetentionDays: 30,
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
  it("returns team when the team slug is active", async () => {
    hasMock = hasPlans("team");
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("returns pro when the pro slug is active", async () => {
    hasMock = hasPlans("pro");
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("falls back to free when no paid slug matches", async () => {
    hasMock = hasPlans(); // nothing active
    const { resolvePlan, CAPS } = await import("../src/lib/plan.ts");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("prefers team over pro when (somehow) both are reported active", async () => {
    hasMock = hasPlans("team", "pro");
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("team");
  });

  it("treats an unrecognized paid slug as free (documents the slug-set risk)", async () => {
    // A Clerk plan whose slug isn't in PRO_SLUGS/TEAM_SLUGS resolves to free.
    // This is the codex #10 footgun: adding a plan in Clerk requires adding
    // its slug to lib/plan.ts. The test pins the current behavior.
    hasMock = hasPlans("pro_annual");
    const { resolvePlan } = await import("../src/lib/plan.ts");
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
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
