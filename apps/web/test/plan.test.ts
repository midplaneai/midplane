// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// resolvePlan() reads the founder/internal override from customers.plan_override
// (via currentCustomer); absent a value it resolves `free` (Stripe billing is a
// later phase) and hasEntitlement() returns false. We mock currentCustomer to
// stage the override. CAPS, the pre-flight block, and the typed limit error are
// pure and asserted directly.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Customer } from "@midplane-cloud/db";

import {
  CAPS,
  PlanLimitError,
  connectionCreateBlock,
  hasEntitlement,
  resolvePlan,
} from "../src/lib/plan.ts";

// currentCustomer is reassigned per-test through a getter so each test can
// stage a different plan_override (or a null customer).
let currentCustomerMock: () => Promise<Customer | null>;

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

function customerWith(planOverride: Customer["planOverride"]): Customer {
  return {
    id: "01HCUSTOMER0000000000000000",
    orgId: "org_1",
    email: "u@e.test",
    region: "eu",
    planOverride,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  currentCustomerMock = async () => customerWith(null);
});

describe("CAPS", () => {
  it("encodes the PRICING.md tiers exactly", () => {
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

  it("models unlimited tiers as Infinity so `count >= cap` is never true", () => {
    expect(999_999 >= CAPS.team.connections).toBe(false);
    expect(999_999 >= CAPS.team.tokens).toBe(false);
  });
});

describe("resolvePlan", () => {
  it("resolves free when plan_override is null", async () => {
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

describe("hasEntitlement", () => {
  it("returns false for every feature (no billing / ee wired yet)", async () => {
    expect(await hasEntitlement("sso")).toBe(false);
  });
});

describe("connectionCreateBlock", () => {
  it("returns null when both caps have room", () => {
    expect(
      connectionCreateBlock({ connections: 3, tokens: 4 }, CAPS.pro),
    ).toBeNull();
  });

  it("flags the connection cap first when it's reached", () => {
    expect(
      connectionCreateBlock({ connections: 1, tokens: 1 }, CAPS.free),
    ).toEqual({ resource: "connections", limit: 1 });
  });

  it("flags the token cap when connections have room but tokens don't", () => {
    // Pro: 10 connections / 50 tokens. Manually minting extra tokens can
    // exhaust the token slot a new connection's default would need before
    // the connection cap is hit.
    expect(
      connectionCreateBlock({ connections: 4, tokens: 50 }, CAPS.pro),
    ).toEqual({ resource: "tokens", limit: 50 });
  });

  it("never blocks on unlimited (Infinity) caps", () => {
    expect(
      connectionCreateBlock({ connections: 999_999, tokens: 999_999 }, CAPS.team),
    ).toBeNull();
  });
});

describe("PlanLimitError", () => {
  it("carries resource, limit, and plan for call-site translation", () => {
    const err = new PlanLimitError("connections", 1, "free");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlanLimitError");
    expect(err.resource).toBe("connections");
    expect(err.limit).toBe(1);
    expect(err.plan).toBe("free");
  });
});
