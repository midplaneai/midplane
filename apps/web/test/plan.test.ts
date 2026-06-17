// Unit coverage for lib/plan.ts — the plan/caps resolution layer.
//
// Billing is not wired yet (Stripe lands in a later phase), so resolvePlan()
// returns `free` for everyone and hasEntitlement() returns false — no session
// read, nothing to mock. CAPS, the pre-flight block, and the typed limit error
// are pure and asserted directly. Tier resolution + the founder override return
// (with coverage) when billing + the override column land.

import { describe, expect, it } from "vitest";

import {
  CAPS,
  PlanLimitError,
  connectionCreateBlock,
  hasEntitlement,
  resolvePlan,
} from "../src/lib/plan.ts";

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
  it("returns free with the free caps (billing not wired yet)", async () => {
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
