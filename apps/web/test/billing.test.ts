// Unit coverage for lib/billing.ts — the Stripe→entitlement mapping seam.
//
// planFromSubscription is the heart of the upgrade/downgrade/cancel/past_due
// transitions AND of idempotency: it's pure, so the same (status, plan) always
// yields the same tier — which is why a replayed webhook event is a no-op (the
// customers.plan write is a state-set, not a delta). isBillingConfigured gates
// whether the plugin loads at all (cloud + all four vars; never in self-host).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBillingConfigured, planFromSubscription } from "../src/lib/billing.ts";

const ALL_STRIPE = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRO_PRICE_ID: "price_pro",
  STRIPE_TEAM_PRICE_ID: "price_team",
};

describe("planFromSubscription", () => {
  it("grants the tier for an active subscription", () => {
    expect(planFromSubscription("active", "pro")).toBe("pro");
    expect(planFromSubscription("active", "team")).toBe("team");
  });

  it("grants the tier during a trial", () => {
    expect(planFromSubscription("trialing", "pro")).toBe("pro");
    expect(planFromSubscription("trialing", "team")).toBe("team");
  });

  it("drops to free for every unentitled status (incl. past_due)", () => {
    for (const status of [
      "past_due",
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ]) {
      expect(planFromSubscription(status, "pro")).toBe("free");
      expect(planFromSubscription(status, "team")).toBe("free");
    }
  });

  it("fails closed to free on an active subscription with an unknown plan name", () => {
    expect(planFromSubscription("active", "enterprise")).toBe("free");
    expect(planFromSubscription("active", null)).toBe("free");
    expect(planFromSubscription("active", undefined)).toBe("free");
  });

  it("is idempotent — replaying the same event yields the same tier (no state change)", () => {
    const once = planFromSubscription("active", "team");
    const twice = planFromSubscription("active", "team");
    expect(once).toBe(twice);
    expect(once).toBe("team");
    // And a stale duplicate of a cancel maps to the same 'free' both times.
    expect(planFromSubscription("canceled", "team")).toBe(
      planFromSubscription("canceled", "team"),
    );
  });
});

describe("isBillingConfigured", () => {
  const prevSelfHost = process.env.MIDPLANE_SELF_HOST;
  beforeEach(() => {
    delete process.env.MIDPLANE_SELF_HOST;
  });
  afterEach(() => {
    if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
  });

  it("true in cloud with all four Stripe vars", () => {
    expect(isBillingConfigured(ALL_STRIPE)).toBe(true);
  });

  it("false in cloud with a partial config", () => {
    expect(
      isBillingConfigured({ STRIPE_SECRET_KEY: "sk_test_x" }),
    ).toBe(false);
  });

  it("false in cloud with no Stripe vars (keyless dev)", () => {
    expect(isBillingConfigured({})).toBe(false);
  });

  it("false in self-host even with all four vars set", () => {
    process.env.MIDPLANE_SELF_HOST = "1";
    expect(isBillingConfigured(ALL_STRIPE)).toBe(false);
  });
});
