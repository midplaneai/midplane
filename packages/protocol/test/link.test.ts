// The status's database health: codes only, strict, and optional, so a cloud
// on this protocol takes a status from a gateway that doesn't send it.

import { describe, expect, it } from "vitest";
import { GatewayStatusSchema, LINK_FEATURES } from "../src/index.ts";

const status = {
  bundle_version: 1,
  state: "enforcing",
  reason: null,
  rejected: null,
  version: "0.22.0",
  features: [LINK_FEATURES.database_health],
  databases: ["main", "orders"],
  nonce: "n".repeat(22),
};

const healthy = { ok: true, code: null, since: "2026-10-02T09:00:00.000Z" };
const down = { ok: false, code: "ECONNREFUSED", since: "2026-10-02T09:00:01Z" };

describe("the status's database health", () => {
  it("is optional, and takes each database's state and code", () => {
    expect(GatewayStatusSchema.safeParse(status).success).toBe(true);
    const parsed = GatewayStatusSchema.parse({
      ...status,
      database_health: { main: healthy, orders: down },
    });
    expect(parsed.database_health).toEqual({ main: healthy, orders: down });
    expect(
      GatewayStatusSchema.safeParse({
        ...status,
        database_health: { orders: { ...down, code: "28P01" } },
      }).success,
    ).toBe(true);
  });

  it("refuses a message, a long code, a bad time or a bad id", () => {
    const bad = [
      { orders: { ...down, message: "password authentication failed" } },
      { orders: { ...down, code: "E".repeat(33) } },
      { orders: { ...down, since: "yesterday" } },
      { orders: { ok: false, code: "ECONNREFUSED" } },
      { orders: { ...down, ok: "no" } },
      { NOT_AN_ID: healthy },
      Object.fromEntries(
        Array.from({ length: 257 }, (_, i) => [`db${i}`, healthy]),
      ),
    ];
    for (const database_health of bad) {
      expect(
        GatewayStatusSchema.safeParse({ ...status, database_health }).success,
        JSON.stringify(database_health).slice(0, 80),
      ).toBe(false);
    }
  });
});
