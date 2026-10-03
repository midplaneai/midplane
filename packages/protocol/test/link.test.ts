// The status's database health: codes only, strict, and optional, so a cloud
// on this protocol takes a status from a gateway that doesn't send it. And
// enrollment's databases, optional both ways for the same reason.

import { describe, expect, it } from "vitest";
import {
  EnrollRequestSchema,
  EnrollResponseSchema,
  GatewayStatusSchema,
  LINK_FEATURES,
} from "../src/index.ts";

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

const enrollment = {
  token: `mpe1_${"A".repeat(86)}`,
  public_key: { kty: "OKP", crv: "Ed25519", x: "x".repeat(43) },
  resources: ["https://gw.example.com/mcp"],
  version: "0.22.0",
  features: [],
};

describe("enrollment's databases", () => {
  it("are optional, and named by id", () => {
    expect(EnrollRequestSchema.safeParse(enrollment).success).toBe(true);
    expect(
      EnrollRequestSchema.parse({
        ...enrollment,
        databases: ["shop", "orders"],
      }).databases,
    ).toEqual(["shop", "orders"]);
  });

  it("are refused when one is listed twice, malformed, or past 256", () => {
    const bad = [
      ["shop", "shop"],
      ["Shop"],
      [""],
      Array.from({ length: 257 }, (_, i) => `db${i}`),
    ];
    for (const databases of bad) {
      expect(
        EnrollRequestSchema.safeParse({ ...enrollment, databases }).success,
        JSON.stringify(databases).slice(0, 80),
      ).toBe(false);
    }
    expect(
      EnrollRequestSchema.safeParse({
        ...enrollment,
        databases: Array.from({ length: 256 }, (_, i) => `db${i}`),
      }).success,
    ).toBe(true);
  });

  it("an answer may name the project and the databases added, or not", () => {
    const answer = { signing_key: enrollment.public_key, identity: "a.b.c" };
    expect(EnrollResponseSchema.parse(answer)).toEqual(answer);
    expect(
      EnrollResponseSchema.parse({
        ...answer,
        project_name: "Production",
        databases_added: ["shop"],
      }),
    ).toMatchObject({ project_name: "Production", databases_added: ["shop"] });
  });
});
