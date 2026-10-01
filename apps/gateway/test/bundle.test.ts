// Invariants 7 and 8 at the unit level: which bundles are authentic and newer
// (everything else is rejected and changes nothing), and which authentic
// bundles halt the gateway instead of being enforced.

import { BUNDLE_JWS_TYPE } from "@midplane/protocol";
import { CompactSign, importJWK, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey } from "../src/auth.ts";
import {
  assessBundle,
  type BundleContext,
  type Held,
  verifyBundle,
} from "../src/bundle.ts";

const ISSUER = "https://cloud.example";
const PROJECT = "prj_1";

let ours: { privateJwk: JWK; publicJwk: JWK };
let theirs: { privateJwk: JWK; publicJwk: JWK };
let key: BundleContext["key"];

beforeAll(async () => {
  ours = await generateSigningKey();
  theirs = await generateSigningKey();
  key = (await importJWK(ours.publicJwk, "EdDSA")) as BundleContext["key"];
});

function payload(extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    iss: ISSUER,
    project_id: PROJECT,
    version: 5,
    iat: 1_790_000_000,
    paused: false,
    crit: [],
    jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "a".repeat(43) }] },
    revoked_tokens: [],
    databases: { main: { table_access: { default: "read" } } },
    ...extra,
  };
}

async function sign(
  p: unknown,
  o: { with?: JWK; typ?: string } = {},
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(p)))
    .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? BUNDLE_JWS_TYPE })
    .sign(await importJWK(o.with ?? ours.privateJwk, "EdDSA"));
}

const ctx = (held: Held | null = null, floor = 0): BundleContext => ({
  key,
  issuer: ISSUER,
  projectId: PROJECT,
  floor,
  held,
});

describe("invariant 7: only authentic, newer bundles for this project", () => {
  it("accepts a bundle signed with the pinned key", async () => {
    const jws = await sign(payload());
    expect(await verifyBundle(jws, ctx())).toMatchObject({
      kind: "new",
      version: 5,
    });
  });

  it("rejects a tampered bundle", async () => {
    const jws = await sign(payload());
    const [h, , s] = jws.split(".");
    const forged = Buffer.from(
      JSON.stringify(payload({ databases: { main: {} }, version: 6 })),
    ).toString("base64url");
    expect(await verifyBundle(`${h}.${forged}.${s}`, ctx())).toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/signature/),
    });
    // A flipped signature byte too.
    const sig = Buffer.from(s ?? "", "base64url");
    sig[0] = (sig[0] ?? 0) ^ 1;
    const flipped = `${h}.${jws.split(".")[1]}.${sig.toString("base64url")}`;
    expect((await verifyBundle(flipped, ctx())).kind).toBe("rejected");
  });

  it("rejects a bundle signed with any other key", async () => {
    const jws = await sign(payload(), { with: theirs.privateJwk });
    expect((await verifyBundle(jws, ctx())).kind).toBe("rejected");
  });

  it("rejects a bundle for another project or from another issuer", async () => {
    const foreign = await sign(payload({ project_id: "prj_other" }));
    expect(await verifyBundle(foreign, ctx())).toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/another project/),
    });
    const elsewhere = await sign(payload({ iss: "https://evil.example" }));
    expect((await verifyBundle(elsewhere, ctx())).kind).toBe("rejected");
  });

  it("rejects an older bundle, and one older than enrollment", async () => {
    const held = { version: 5, jws: await sign(payload()) };
    const older = await sign(payload({ version: 4 }));
    expect(await verifyBundle(older, ctx(held))).toMatchObject({
      kind: "rejected",
      version: 4,
    });
    expect(await verifyBundle(older, ctx(null, 5))).toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/enrollment/),
    });
  });

  it("treats the same bytes as a repeat and the same version with other bytes as a rejection", async () => {
    const jws = await sign(payload());
    const held = { version: 5, jws };
    expect(await verifyBundle(jws, ctx(held))).toEqual({ kind: "repeat" });
    const other = await sign(payload({ paused: true }));
    expect(await verifyBundle(other, ctx(held))).toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/different contents/),
    });
  });

  it("rejects the cloud's other signed documents as bundles", async () => {
    const identity = await sign(payload(), { typ: "mp-identity" });
    expect((await verifyBundle(identity, ctx())).kind).toBe("rejected");
  });

  it("rejects an unsigned or garbled bundle", async () => {
    const [h, p] = (await sign(payload())).split(".");
    expect((await verifyBundle(`${h}.${p}.`, ctx())).kind).toBe("rejected");
    expect((await verifyBundle("not a jws", ctx())).kind).toBe("rejected");
  });
});

describe("invariant 8: unknown critical fields or features halt", () => {
  const abilities = {
    databases: new Set(["main"]),
    hasSalt: true,
    gatewayId: "gw_1",
  };

  it("enforces a bundle with every policy it can read", () => {
    const a = assessBundle(payload(), abilities);
    expect(a.kind).toBe("enforce");
    if (a.kind === "enforce") {
      expect(a.policies.get("main")?.table_access.default).toBe("read");
    }
  });

  it("ignores unknown optional fields", () => {
    expect(
      assessBundle(payload({ approvals_channel: "slack" }), abilities).kind,
    ).toBe("enforce");
  });

  it("halts on an unknown critical field", () => {
    const a = assessBundle(
      payload({ row_filters: {}, crit: ["row_filters"] }),
      abilities,
    );
    expect(a).toMatchObject({
      kind: "halt",
      reason: expect.stringMatching(/row_filters/),
    });
  });

  it("enforces when crit names only fields it knows", () => {
    expect(
      assessBundle(payload({ crit: ["databases", "jwks"] }), abilities).kind,
    ).toBe("enforce");
  });

  it("halts on a policy feature the core lacks", () => {
    const a = assessBundle(
      payload({
        databases: { main: { requires_features: ["tenant_scope"] } },
      }),
      abilities,
    );
    expect(a).toMatchObject({
      kind: "halt",
      reason: expect.stringMatching(/tenant_scope/),
    });
  });

  it("halts on a policy key the strict schema doesn't know", () => {
    expect(
      assessBundle(
        payload({ databases: { main: { tenant_scope: { column: "org" } } } }),
        abilities,
      ).kind,
    ).toBe("halt");
  });

  it("halts on a newer bundle format", () => {
    expect(assessBundle(payload({ v: 2 }), abilities)).toMatchObject({
      kind: "halt",
      reason: expect.stringMatching(/format 2/),
    });
  });

  it("halts when a database it serves has masks and it has no salt", () => {
    const masked = payload({
      databases: { main: { masks: { "public.users": { email: "null-out" } } } },
    });
    expect(assessBundle(masked, { ...abilities, hasSalt: false }).kind).toBe(
      "halt",
    );
    expect(
      assessBundle(masked, {
        ...abilities,
        databases: new Set(["other"]),
        hasSalt: false,
      }).kind,
    ).toBe("enforce");
  });

  it("pauses a paused project's gateways", () => {
    expect(assessBundle(payload({ paused: true }), abilities).kind).toBe(
      "paused",
    );
  });
});

describe("the URLs a bundle registers for this gateway", () => {
  const abilities = {
    databases: new Set(["main"]),
    hasSalt: true,
    gatewayId: "gw_1",
  };
  const direct = "https://db.example.com/mcp";
  const tunnel = "https://db.abc123.tunnel.example.com/mcp";

  it("are this gateway's entry, enforced or paused", () => {
    const gateways = {
      gw_1: { resources: [direct, tunnel] },
      gw_2: { resources: ["https://other.example.com/mcp"] },
    };
    expect(assessBundle(payload({ gateways }), abilities)).toMatchObject({
      kind: "enforce",
      resources: [direct, tunnel],
    });
    expect(
      assessBundle(payload({ gateways, paused: true }), abilities),
    ).toMatchObject({ kind: "paused", resources: [direct, tunnel] });
  });

  it("are unknown in a bundle that lists no gateways", () => {
    expect(assessBundle(payload(), abilities)).toMatchObject({
      kind: "enforce",
      resources: null,
    });
  });

  it("halt the gateway when they aren't URLs it can answer on", () => {
    for (const resources of [
      ["not a url"],
      ["ftp://db.example.com/mcp"],
      ["https://db.example.com/other"],
      Array.from({ length: 9 }, (_, i) => `https://db${i}.example.com/mcp`),
    ]) {
      expect(
        assessBundle(payload({ gateways: { gw_1: { resources } } }), abilities),
      ).toMatchObject({ kind: "halt" });
    }
  });

  it("halt the gateway when the bundle registers none for it", () => {
    for (const gateways of [
      { gw_2: { resources: [direct] } },
      { gw_1: { resources: [] } },
    ]) {
      expect(assessBundle(payload({ gateways }), abilities)).toMatchObject({
        kind: "halt",
        reason: expect.stringMatching(/no URL for this gateway/),
      });
    }
  });
});
