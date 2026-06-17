// Unit coverage for lib/seats.ts — the per-plan seat cap wired into Better
// Auth's organization.membershipLimit. We mock getDb to stage the customer's
// plan_override and assert the resolved seat cap.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows returned by the fake drizzle select().from().where() chain.
let rows: Array<{ planOverride: "free" | "pro" | "team" | null }> = [];

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

beforeEach(() => {
  process.env.MIDPLANE_REGION = "eu";
  rows = [];
});

describe("seatCapForOrg", () => {
  it("free cap (1) for a customer with no override", async () => {
    rows = [{ planOverride: null }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(1);
  });

  it("pro cap (10) when plan_override = 'pro'", async () => {
    rows = [{ planOverride: "pro" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(10);
  });

  it("unlimited (Infinity) when plan_override = 'team'", async () => {
    rows = [{ planOverride: "team" }];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_1")).toBe(Infinity);
  });

  it("free cap (1) — the safe floor — when no customer row exists yet", async () => {
    rows = [];
    const { seatCapForOrg } = await import("../src/lib/seats.ts");
    expect(await seatCapForOrg("org_unknown")).toBe(1);
  });
});
