// Policy bundle verification.
//
// The property under test: nothing that isn't an authentic, newer bundle for
// THIS project can change what a gateway enforces. Every forged, foreign or
// stale bundle comes back `reject`; only the pinned key's newer statements come
// back `authentic`; and whether an authentic bundle can be honoured (format
// version, `crit`) is reported separately, because that answer halts rather
// than rejects.

import { describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import {
  BUNDLE_TYP,
  MAX_BUNDLE_BYTES,
  verifyBundle,
  type BundleExpectations,
} from "../../src/gateway/protocol.ts";
import {
  ISSUER,
  PROJECT,
  bundle,
  craftJws,
  decodePayload,
  hmacWithPublicKey,
  testKey,
} from "./_fixtures.ts";

const signer = testKey();
const other = testKey();

function expectations(over: Partial<BundleExpectations> = {}): BundleExpectations {
  return {
    signer: { kid: signer.kid, publicKey: signer.publicKey },
    issuer: ISSUER,
    projectId: PROJECT,
    current: null,
    minVersion: 1,
    ...over,
  };
}

function reasonOf(jws: string, over: Partial<BundleExpectations> = {}): string {
  const v = verifyBundle(jws, expectations(over));
  return v.kind === "reject" ? v.reason : v.kind;
}

describe("verifyBundle — authentic bundles", () => {
  test("a bundle from the pinned key for this project is authentic and enforceable", () => {
    const jws = bundle(signer, { version: 3 });
    const v = verifyBundle(jws, expectations());
    expect(v.kind).toBe("authentic");
    if (v.kind !== "authentic" || !v.envelope.ok) throw new Error("expected enforceable");
    expect(v.version).toBe(3);
    expect(v.jws).toBe(jws);
    expect(v.envelope.claims.policy).toContain("public.orders: read");
    expect(v.envelope.claims.paused).toBe(false);
    expect(v.envelope.ignoredFields).toEqual([]);
  });

  test("re-fetching the bundle already held is a no-op", () => {
    const jws = bundle(signer, { version: 5 });
    expect(reasonOf(jws, { current: { version: 5, jws } })).toBe("noop");
  });

  test("the enrollment floor itself is accepted before any bundle is held", () => {
    // min_version is the latest version at enrollment — the gateway must be
    // able to take exactly that bundle as its first.
    expect(reasonOf(bundle(signer, { version: 42 }), { minVersion: 42 })).toBe("authentic");
  });
});

describe("verifyBundle — rejects (enforcement unchanged)", () => {
  const good = bundle(signer, { version: 2 });

  test("signed by a key other than the pinned one", () => {
    // Same kid claimed, different key: the signature is what fails.
    const forged = bundle({ ...other, kid: signer.kid }, { version: 2 });
    expect(reasonOf(forged)).toBe("signature");
  });

  test("a kid other than the pinned key's", () => {
    expect(reasonOf(bundle(other, { version: 2 }))).toBe("unknown_kid");
  });

  test("tampered payload (policy loosened after signing)", () => {
    const [h, , s] = good.split(".");
    const payload = decodePayload(good);
    payload.policy = String(payload.policy).replace("default: deny", "default: read_write");
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    expect(reasonOf(tampered)).toBe("signature");
  });

  test("tampered header", () => {
    const [, p, s] = good.split(".");
    const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: signer.kid, typ: "other+jws" })).toString("base64url");
    expect(reasonOf(`${h}.${p}.${s}`)).toBe("header");
  });

  test("alg: none", () => {
    const jws = craftJws({ alg: "none", typ: BUNDLE_TYP, kid: signer.kid }, decodePayload(good), () => Buffer.from("x"));
    expect(reasonOf(jws)).toBe("header");
  });

  test("alg: HS256 keyed with the public key (algorithm confusion)", () => {
    const jws = craftJws({ alg: "HS256", typ: BUNDLE_TYP, kid: signer.kid }, decodePayload(good), hmacWithPublicKey(signer));
    expect(reasonOf(jws)).toBe("header");
  });

  test("an extra header member (jku, crit, a second key) is refused, not ignored", () => {
    for (const extra of [{ jku: "https://evil.test/keys" }, { crit: ["exp"] }, { jwk: { kty: "OKP" } }]) {
      const jws = craftJws(
        { alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid, ...extra },
        decodePayload(good),
        (input) => sign(null, input, signer.privateKey),
      );
      expect(reasonOf(jws)).toBe("header");
    }
  });

  test("a bundle for another project", () => {
    expect(reasonOf(bundle(signer, { version: 2, project_id: "01J8Z6Q3OTHERPROJECTAAAAAA" }))).toBe("project");
  });

  test("a bundle from another issuer (e.g. the other region)", () => {
    expect(reasonOf(bundle(signer, { version: 2, iss: "https://us.app.midplane.test" }))).toBe("issuer");
  });

  test("an older version than the one held (rollback)", () => {
    const held = bundle(signer, { version: 7 });
    expect(reasonOf(bundle(signer, { version: 6 }), { current: { version: 7, jws: held } })).toBe("rollback");
  });

  test("an older version than the enrollment floor, with no bundle held yet", () => {
    // The adversary the key pin defends against could otherwise hand a freshly
    // enrolled gateway v1 of a project that is now at v42.
    expect(reasonOf(bundle(signer, { version: 1 }), { minVersion: 42 })).toBe("rollback");
  });

  test("the same version with different bytes", () => {
    const held = bundle(signer, { version: 7 });
    const twin = bundle(signer, { version: 7, policy: "databases: []\n" });
    expect(reasonOf(twin, { current: { version: 7, jws: held } })).toBe("version_conflict");
  });

  test("oversize", () => {
    const huge = "a".repeat(MAX_BUNDLE_BYTES + 1);
    expect(reasonOf(huge)).toBe("oversize");
  });

  test("structurally broken inputs", () => {
    for (const junk of ["", "a.b", "a.b.c.d", "!!!.***.???", `${good}x`, good.replace(".", "..")]) {
      expect(["malformed", "signature", "header"]).toContain(reasonOf(junk));
    }
  });

  test("non-canonical base64url is refused, so one bundle has exactly one encoding", () => {
    const [h, p, s] = good.split(".");
    expect(reasonOf(`${h}=.${p}.${s}`)).toBe("malformed");
  });

  test("a signed payload missing its binding fields", () => {
    const jws = craftJws(
      { alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid },
      { v: 1, iss: ISSUER, project_id: PROJECT, policy: "x" },
      (input) => sign(null, input, signer.privateKey),
    );
    expect(reasonOf(jws)).toBe("malformed");
  });

  test("a v1 bundle with a mistyped v1 field is malformed, not a reason to halt", () => {
    const payload = { ...decodePayload(good), paused: "true" };
    const jws = craftJws({ alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid }, payload, (input) =>
      sign(null, input, signer.privateKey),
    );
    expect(reasonOf(jws)).toBe("malformed");
  });

  test("a reject carries the claimed version when it could be read, for the heartbeat", () => {
    const v = verifyBundle(bundle(signer, { version: 9, project_id: "01OTHER" }), expectations());
    expect(v).toMatchObject({ kind: "reject", reason: "project", version: 9 });
  });
});

describe("verifyBundle — envelope fields (crit)", () => {
  test("an unknown field NOT listed in crit is ignored", () => {
    const v = verifyBundle(bundle(signer, { version: 2 }, { display_label: "Q3 lockdown" }), expectations());
    if (v.kind !== "authentic" || !v.envelope.ok) throw new Error("expected enforceable");
    expect(v.envelope.ignoredFields).toEqual(["display_label"]);
  });

  test("an unknown field listed in crit makes the bundle authentic but unenforceable", () => {
    const v = verifyBundle(
      bundle(signer, { version: 2, crit: ["max_staleness"] }, { max_staleness: 3600 }),
      expectations(),
    );
    expect(v.kind).toBe("authentic");
    if (v.kind !== "authentic") return;
    expect(v.envelope.ok).toBe(false);
    if (!v.envelope.ok) expect(v.envelope.reason).toContain("max_staleness");
  });

  test("a known field listed in crit is fine", () => {
    const v = verifyBundle(bundle(signer, { version: 2, crit: ["paused"] }), expectations());
    expect(v.kind === "authentic" && v.envelope.ok).toBe(true);
  });

  test("a future envelope format is authentic but unenforceable (upgrade, don't guess)", () => {
    const jws = craftJws(
      { alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid },
      { v: 2, iss: ISSUER, project_id: PROJECT, version: 3, policies: { main: "…" } },
      (input) => sign(null, input, signer.privateKey),
    );
    const v = verifyBundle(jws, expectations());
    expect(v.kind).toBe("authentic");
    if (v.kind === "authentic" && !v.envelope.ok) expect(v.envelope.reason).toContain("format v2");
  });

  test("a paused bundle is authentic and enforceable; pausing is the caller's job", () => {
    const v = verifyBundle(bundle(signer, { version: 2, paused: true }), expectations());
    if (v.kind !== "authentic" || !v.envelope.ok) throw new Error("expected enforceable");
    expect(v.envelope.claims.paused).toBe(true);
  });
});
