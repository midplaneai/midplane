// Unit coverage for lib/seats.ts — the per-plan seat cap wired into Better
// Auth's organization.membershipLimit. We mock getDb to stage the customer's
// plan_override + subscription-backed plan and assert the resolved seat cap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Tier = "free" | "pro" | "team";

// Rows returned by the fake drizzle select().from().where() chain.
let rows: Array<{ planOverride: Tier | null; plan: Tier }> = [];

vi.mock("@midplane-cloud/db", async () => {
  const real =
    await vi.importActual<typeof import("@midplane-cloud/db")>(
      "@midplane-cloud/db",
    );
  return {
    ...real,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    }),
  };
});

const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

beforeEach(() => {
  process.env.MIDPLANE_REGION = "eu";
  delete process.env.MIDPLANE_SELF_HOST;
  rows = [];
});

afterEach(() => {
  if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
  else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
});

describe("seatCapForOrg", () => {
  it("unlimited (Infinity) in self-host — before any DB read", async () => {
    // The implicit customer row carries no plan, so without the self-host
    // short-circuit this would resolve to `free` (cap 1) and block the second
    // member (acceptInvitation). rows stays empty: no DB read should happen.
    process.env.MIDPLANE_SELF_HOST = "1";
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("self-host-org")).toBe(Infinity);
  });

  it("free cap (1) for a customer with no override and no subscription", async () => {
    rows = [{ planOverride: null, plan: "free" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(1);
  });

  it("pro cap (10) when plan_override = 'pro'", async () => {
    rows = [{ planOverride: "pro", plan: "free" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(10);
  });

  it("unlimited (Infinity) when plan_override = 'team'", async () => {
    rows = [{ planOverride: "team", plan: "free" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(Infinity);
  });

  it("pro cap (10) from the subscription-backed plan when no override", async () => {
    rows = [{ planOverride: null, plan: "pro" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(10);
  });

  it("plan_override beats the subscription plan (override 'free' caps a 'team' subscriber)", async () => {
    rows = [{ planOverride: "free", plan: "team" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(1);
  });

  it("free cap (1) — the safe floor — when no customer row exists yet", async () => {
    rows = [];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_unknown")).toBe(1);
  });
});
