// The status's database health: codes only, strict, and optional, so a cloud
// on this protocol takes a status from a gateway that doesn't send it. And
// enrollment's databases, optional both ways for the same reason. And the
// sync answer's releases, which gateways before them drop.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EnrollRequestSchema,
  EnrollResponseSchema,
  GatewayStatusSchema,
  LINK_FEATURES,
  SyncResponseSchema,
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

/**
 * `SyncResponseSchema` as gateway 0.24.0 has it (`src/link.ts` and
 * `src/claims.ts` at c144c6a, the commit that made it 0.24.0), copied
 * whole: unchanged since 0.21.0, and 0.24.1 has it too.
 */
const SyncResponseSchema_0_24_0 = z.object({
  bundle: z.string().min(1).optional(),
  freshness: z.string().min(1).optional(),
  commands: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        kind: z.string().min(1),
        payload: z.unknown(),
      }),
    )
    .default([]),
  catalogs: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
      z.string().regex(/^[0-9a-f]{64}$/),
    )
    .refine((r) => Object.keys(r).length <= 256, "too many databases")
    .default({}),
});

const answer = {
  freshness: "a.b.c",
  commands: [{ id: "cmd_1", kind: "test_connection", payload: {} }],
  catalogs: { shop: "a".repeat(64) },
};
const release = {
  latest: "0.25.0",
  needed: {
    version: "0.24.1",
    reason: "Fixes a mask that could be bypassed.",
    advisory:
      "https://github.com/midplaneai/midplane/security/advisories/GHSA-xxxx-xxxx-xxxx",
  },
};

describe("the sync answer's releases", () => {
  // protects=#85 criterion 4: older gateways keep syncing: an answer with `release`, `needed` and its advisory included, parses under 0.24.0's schema with the rest intact, and under this one with `release` kept;
  // fails_when=the new field breaks a 0.24.0 parse, or this schema drops or refuses a well-formed release;
  // no_claim=versions before 0.24.0, which use the same plain `z.object` (copied above, not run from their builds)
  it("pass a gateway that doesn't know them, and one that does", () => {
    const sent = { ...answer, release };
    const older = SyncResponseSchema_0_24_0.safeParse(sent);
    expect(older.success).toBe(true);
    expect(older.data).toEqual(answer);
    expect(SyncResponseSchema.parse(sent)).toEqual(sent);
    expect(
      SyncResponseSchema.parse({ ...answer, release: { latest: "0.25.0" } })
        .release,
    ).toEqual({ latest: "0.25.0" });
  });

  // protects=#85 criterion 4: an answer without `release`, as a cloud without a stored release or before #85 sends it, passes the new schema with no `release`;
  // fails_when=the new schema requires the field, or invents one;
  // no_claim=what the cloud sends (cloud/app/test/link.e2e.test.ts)
  it("are optional", () => {
    const parsed = SyncResponseSchema.parse(answer);
    expect(parsed).toEqual(answer);
    expect(parsed).not.toHaveProperty("release");
  });

  // protects=a malformed `release` costs a gateway its log line only: the answer still parses, with its bundle, commands and catalogs, and no release;
  // fails_when=a reason over 200 characters, a version over 64, an advisory that isn't a URL or a release that isn't an object fails the whole sync answer, or reaches the log;
  // no_claim=what the gateway logs (oss/apps/gateway/test/release-notice.test.ts)
  it("are dropped when malformed, and the answer kept", () => {
    const needed = release.needed;
    for (const bad of [
      { ...release, needed: { ...needed, reason: "r".repeat(201) } },
      { ...release, needed: { ...needed, reason: "" } },
      { ...release, needed: { ...needed, advisory: "see the notes" } },
      { ...release, latest: "0".repeat(65) },
      { needed },
      "0.25.0",
    ]) {
      const parsed = SyncResponseSchema.parse({ ...answer, release: bad });
      expect(parsed.release, JSON.stringify(bad).slice(0, 80)).toBeUndefined();
      expect(parsed).toMatchObject(answer);
    }
  });
});
