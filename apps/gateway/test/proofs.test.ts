// The signed answers a gateway acts on: each binds its type, the issuer,
// the project and what the gateway asked about, and a decision can't be
// claimed after it expires, whatever the cloud says.

import {
  APPROVAL_JWS_TYPE,
  APPROVAL_WINDOWS,
  AUDIT_ACK_JWS_TYPE,
  CLAIM_JWS_TYPE,
  TAINT_JWS_TYPE,
} from "@midplane/protocol";
import { CompactSign, importJWK, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey } from "../src/auth.ts";
import {
  verifyAuditAck,
  verifyClaim,
  verifyDecision,
  verifyTaint,
} from "../src/proofs.ts";

let privateJwk: JWK;
let key: Awaited<ReturnType<typeof importJWK>>;
const ctx = () => ({
  key: key as Parameters<typeof verifyDecision>[1]["key"],
  issuer: "https://cloud.test",
  projectId: "prj_1",
});

const sign = async (payload: unknown, typ: string) =>
  new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA", typ })
    .sign(await importJWK(privateJwk, "EdDSA"));

beforeAll(async () => {
  const k = await generateSigningKey();
  privateJwk = k.privateJwk;
  key = await importJWK(k.publicJwk, "EdDSA");
});

describe("decisions", () => {
  const decision = (o: Record<string, unknown> = {}) => ({
    v: 1,
    iss: "https://cloud.test",
    project_id: "prj_1",
    approval_id: "apv_1",
    database: "main",
    approval_key: "a".repeat(64),
    grant_id: "grant-1",
    preview: { count: 2, exact: true },
    expires_at: Math.floor(Date.now() / 1000) + 60,
    decided_by: "Pat",
    iat: Math.floor(Date.now() / 1000),
    ...o,
  });
  const expect_ = {
    approvalId: "apv_1",
    database: "main",
    approvalKey: "a".repeat(64),
    grantId: "grant-1",
  };

  it("accepts a decision for exactly this statement", async () => {
    const jws = await sign(decision(), APPROVAL_JWS_TYPE);
    expect(await verifyDecision(jws, { ...ctx(), ...expect_ })).toMatchObject({
      preview: { count: 2, exact: true },
      decided_by: "Pat",
    });
  });

  it("refuses one that expired, beyond a few seconds of skew", async () => {
    const at = Date.now();
    const jws = await sign(
      decision({ expires_at: Math.floor(at / 1000) - 10 }),
      APPROVAL_JWS_TYPE,
    );
    expect(
      await verifyDecision(jws, { ...ctx(), ...expect_, now: at }),
    ).toBeNull();
    const fresh = await sign(
      decision({ expires_at: Math.floor(at / 1000) - 2 }),
      APPROVAL_JWS_TYPE,
    );
    expect(
      await verifyDecision(fresh, { ...ctx(), ...expect_, now: at }),
    ).not.toBeNull();
  });

  it("refuses one that lasts longer than an approval may", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const at = (minutes: number) =>
      sign(
        decision({ iat, expires_at: iat + minutes * 60 }),
        APPROVAL_JWS_TYPE,
      );
    expect(
      await verifyDecision(await at(APPROVAL_WINDOWS.approved.max), {
        ...ctx(),
        ...expect_,
      }),
    ).not.toBeNull();
    expect(
      await verifyDecision(await at(APPROVAL_WINDOWS.approved.max + 1), {
        ...ctx(),
        ...expect_,
      }),
    ).toBeNull();
  });

  it("refuses another type, issuer, project, approval, database, key or grant", async () => {
    const wrong = [
      [decision(), CLAIM_JWS_TYPE],
      [decision({ iss: "https://other.test" }), APPROVAL_JWS_TYPE],
      [decision({ project_id: "prj_2" }), APPROVAL_JWS_TYPE],
      [decision({ approval_id: "apv_2" }), APPROVAL_JWS_TYPE],
      [decision({ database: "other" }), APPROVAL_JWS_TYPE],
      [decision({ approval_key: "b".repeat(64) }), APPROVAL_JWS_TYPE],
      [decision({ grant_id: "grant-2" }), APPROVAL_JWS_TYPE],
    ] as const;
    for (const [payload, typ] of wrong) {
      const jws = await sign(payload, typ);
      expect(await verifyDecision(jws, { ...ctx(), ...expect_ })).toBeNull();
    }
    expect(
      await verifyDecision("not.a.jws", { ...ctx(), ...expect_ }),
    ).toBeNull();
  });
});

describe("claims and taint", () => {
  it("bind the nonce the gateway sent", async () => {
    const claim = await sign(
      {
        v: 1,
        iss: "https://cloud.test",
        project_id: "prj_1",
        approval_id: "apv_1",
        nonce: "n".repeat(22),
        iat: 0,
      },
      CLAIM_JWS_TYPE,
    );
    expect(
      await verifyClaim(claim, {
        ...ctx(),
        approvalId: "apv_1",
        nonce: "n".repeat(22),
      }),
    ).toMatchObject({ approval_id: "apv_1" });
    expect(
      await verifyClaim(claim, {
        ...ctx(),
        approvalId: "apv_1",
        nonce: "m".repeat(22),
      }),
    ).toBeNull();
    // A real claim of another approval, for this nonce, doesn't fit either.
    expect(
      await verifyClaim(claim, {
        ...ctx(),
        approvalId: "apv_2",
        nonce: "n".repeat(22),
      }),
    ).toBeNull();

    const taint = await sign(
      {
        v: 1,
        iss: "https://cloud.test",
        project_id: "prj_1",
        grant_id: "grant-1",
        tainted: false,
        since: null,
        source: null,
        nonce: "n".repeat(22),
        iat: 0,
      },
      TAINT_JWS_TYPE,
    );
    const t = { ...ctx(), grantId: "grant-1", nonce: "n".repeat(22) };
    expect(await verifyTaint(taint, t)).toMatchObject({ tainted: false });
    expect(await verifyTaint(taint, { ...t, grantId: "grant-2" })).toBeNull();
    expect(
      await verifyTaint(taint, { ...t, nonce: "m".repeat(22) }),
    ).toBeNull();
  });
});

describe("audit acks", () => {
  it("bind the gateway, the file's instance, the nonce and the body sent", async () => {
    // Value: protects=an audit ack makes the gateway stop owing events only for its own file, this request and the bytes it posted; fails_when=verifyAuditAck drops its gateway, instance, nonce or body hash check, or takes another JWS type; why_new=the ack's binding was tested only end to end, by key and nonce; seam=none
    const payload = {
      v: 1,
      iss: "https://cloud.test",
      project_id: "prj_1",
      gateway_id: "gw_1",
      instance: "inst-1",
      acked: 5,
      hash: "a".repeat(64),
      conflict: null,
      body_sha256: "b".repeat(64),
      nonce: "n".repeat(22),
      iat: 0,
    };
    const ack = await sign(payload, AUDIT_ACK_JWS_TYPE);
    const a = {
      ...ctx(),
      gatewayId: "gw_1",
      instance: "inst-1",
      nonce: "n".repeat(22),
      bodySha256: "b".repeat(64),
    };
    expect(await verifyAuditAck(ack, a)).toMatchObject({
      acked: 5,
      hash: "a".repeat(64),
    });
    expect(await verifyAuditAck(ack, { ...a, instance: "inst-2" })).toBeNull();
    expect(await verifyAuditAck(ack, { ...a, gatewayId: "gw_2" })).toBeNull();
    expect(await verifyAuditAck(ack, { ...a, projectId: "prj_2" })).toBeNull();
    expect(
      await verifyAuditAck(ack, { ...a, nonce: "m".repeat(22) }),
    ).toBeNull();
    // An ack of a batch cut or changed on the way covers other bytes.
    expect(
      await verifyAuditAck(ack, { ...a, bodySha256: "c".repeat(64) }),
    ).toBeNull();
    // Value: protects=an ack that doesn't say whether the cloud holds a conflicting event is no ack; fails_when=AuditAckPayloadSchema's conflict becomes optional; why_new=the ack had no conflict to name; seam=none
    const { conflict: _, ...silent } = payload;
    expect(
      await verifyAuditAck(await sign(silent, AUDIT_ACK_JWS_TYPE), a),
    ).toBeNull();
    // Another type of proof is no ack, whatever it carries.
    expect(
      await verifyAuditAck(await sign(payload, TAINT_JWS_TYPE), a),
    ).toBeNull();
  });
});
