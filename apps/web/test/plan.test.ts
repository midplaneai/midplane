// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// resolvePlan() resolves (via currentCustomer) in order: plan_override (the
// manual lever, which BEATS the subscription) → the subscription-backed
// customers.plan written by the Stripe webhook → `free`. hasEntitlement()
// returns false (ee not wired). We mock currentCustomer to stage both columns.
// CAPS, the pre-flight block, and the typed limit error are pure and asserted
// directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Customer } from "@midplane-cloud/db";

import {
  CAPS,
  PlanLimitError,
  SELF_HOST_CAPS,
  projectCreateBlock,
  hasEntitlement,
  resolvePlan,
} from "../src/lib/plan.ts";

// currentCustomer is reassigned per-test through a getter so each test can
// stage a different plan_override / subscription plan (or a null customer).
let currentCustomerMock: () => Promise<Customer | null>;

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

function customerWith(
  planOverride: Customer["planOverride"],
  plan: Customer["plan"] = "free",
): Customer {
  return {
    id: "01HCUSTOMER0000000000000000",
    orgId: "org_1",
    email: "u@e.test",
    region: "eu",
    planOverride,
    plan,
    ownerEmail: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  currentCustomerMock = async () => customerWith(null);
});

describe("CAPS", () => {
  it("encodes the PRICING.md tiers exactly", () => {
    expect(CAPS.free).toEqual({
      projects: 1,
      tokens: 5,
      auditRetentionDays: 7,
      sso: false,
      seats: 1,
    });
    expect(CAPS.pro).toEqual({
      projects: 10,
      tokens: 50,
      auditRetentionDays: 30,
      sso: false,
      seats: 10,
    });
    expect(CAPS.team).toEqual({
      projects: Infinity,
      tokens: Infinity,
      auditRetentionDays: 90,
      sso: true,
      seats: Infinity,
    });
  });

  it("models unlimited tiers as Infinity so `count >= cap` is never true", () => {
    expect(999_999 >= CAPS.team.projects).toBe(false);
    expect(999_999 >= CAPS.team.tokens).toBe(false);
  });
});

describe("resolvePlan", () => {
  it("resolves free when plan_override is null and plan is 'free'", async () => {
    currentCustomerMock = async () => customerWith(null);
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("resolves free when there is no customer", async () => {
    currentCustomerMock = async () => null;
    const { plan } = await resolvePlan();
    expect(plan).toBe("free");
  });

  it("resolves the subscription-backed plan when no override (plan = 'pro')", async () => {
    currentCustomerMock = async () => customerWith(null, "pro");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("resolves the subscription-backed plan when no override (plan = 'team')", async () => {
    currentCustomerMock = async () => customerWith(null, "team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("plan_override BEATS the subscription plan (override 'team' over plan 'free')", async () => {
    currentCustomerMock = async () => customerWith("team", "free");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("plan_override can DOWNGRADE below the subscription (override 'free' over plan 'team')", async () => {
    // Support lever: cap a paying org for abuse/refund without touching Stripe.
    currentCustomerMock = async () => customerWith("free", "team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });

  it("forces team caps when plan_override is 'team' (no subscription needed)", async () => {
    currentCustomerMock = async () => customerWith("team");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(CAPS.team);
  });

  it("forces pro caps when plan_override is 'pro'", async () => {
    currentCustomerMock = async () => customerWith("pro");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("pro");
    expect(caps).toEqual(CAPS.pro);
  });

  it("can force a LOWER tier ('free') to exercise the capped UI", async () => {
    currentCustomerMock = async () => customerWith("free");
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("free");
    expect(caps).toEqual(CAPS.free);
  });
});

describe("resolvePlan in self-host (MIDPLANE_SELF_HOST=1)", () => {
  const prev = process.env.MIDPLANE_SELF_HOST;
  beforeEach(() => {
    process.env.MIDPLANE_SELF_HOST = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prev;
  });

  it("returns uncapped caps and never reads a customer", async () => {
    // Self-host resolves BEFORE the customer.ts import — if it didn't, this
    // mock would throw and fail the test, proving the early return.
    currentCustomerMock = async () => {
      throw new Error("resolvePlan must not read a customer in self-host");
    };
    const { plan, caps } = await resolvePlan();
    expect(plan).toBe("team");
    expect(caps).toEqual(SELF_HOST_CAPS);
    // Uncapped: count >= cap is never true; Infinity retention = no clamp.
    expect(caps.projects).toBe(Infinity);
    expect(caps.tokens).toBe(Infinity);
    expect(caps.auditRetentionDays).toBe(Infinity);
    expect(caps.seats).toBe(Infinity);
    // sso stays gated (ee, license-deferred) even uncapped.
    expect(caps.sso).toBe(false);
  });
});

describe("hasEntitlement", () => {
  it("returns false for every feature (no billing / ee wired yet)", async () => {
    expect(await hasEntitlement("sso")).toBe(false);
  });
});

describe("projectCreateBlock", () => {
  it("returns null when both caps have room", () => {
    expect(
      projectCreateBlock({ projects: 3, tokens: 4 }, CAPS.pro),
    ).toBeNull();
  });

  it("flags the project cap first when it's reached", () => {
    expect(
      projectCreateBlock({ projects: 1, tokens: 1 }, CAPS.free),
    ).toEqual({ resource: "projects", limit: 1 });
  });

  it("flags the token cap when projects have room but tokens don't", () => {
    // Pro: 10 projects / 50 tokens. Manually minting extra tokens can
    // exhaust the token slot a new project's default would need before
    // the project cap is hit.
    expect(
      projectCreateBlock({ projects: 4, tokens: 50 }, CAPS.pro),
    ).toEqual({ resource: "tokens", limit: 50 });
  });

  it("never blocks on unlimited (Infinity) caps", () => {
    expect(
      projectCreateBlock({ projects: 999_999, tokens: 999_999 }, CAPS.team),
    ).toBeNull();
  });
});

describe("PlanLimitError", () => {
  it("carries resource, limit, and plan for call-site translation", () => {
    const err = new PlanLimitError("projects", 1, "free");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlanLimitError");
    expect(err.resource).toBe("projects");
    expect(err.limit).toBe(1);
    expect(err.plan).toBe("free");
  });
});
