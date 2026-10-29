// The link answers a gateway acts on, verified against the bundle key it
// pinned at enrollment: a person's decision on a held write, the claim of
// that decision for one nonce, a grant's taint for one nonce, and the ack of
// an audit batch for one nonce and body. Before enrolling, setup verifies
// where the relay is, for its nonce, against the key its token pins.
// Anything that doesn't verify is null, and the caller fails closed: nothing
// runs, the grant counts as tainted, the events stay owed, or nothing is
// set up.

import {
  APPROVAL_JWS_TYPE,
  APPROVAL_WINDOWS,
  AUDIT_ACK_JWS_TYPE,
  type AuditAckPayload,
  AuditAckPayloadSchema,
  CLAIM_JWS_TYPE,
  type ClaimPayload,
  ClaimPayloadSchema,
  type DecisionPayload,
  DecisionPayloadSchema,
  RELAY_JWS_TYPE,
  type RelayPayload,
  RelayPayloadSchema,
  TAINT_JWS_TYPE,
  type TaintPayload,
  TaintPayloadSchema,
} from "@midplane/protocol";
import { compactVerify } from "jose";
import type { z } from "zod";

type VerifyKey = Parameters<typeof compactVerify>[1];

export interface ProofContext {
  /** The cloud's bundle-signing key, pinned at enrollment. */
  key: VerifyKey;
  issuer: string;
  projectId: string;
}

/** Tolerated clock difference between gateway and cloud. */
const SKEW_MS = 5_000;

/** The payload of a JWS of this type, signed with `key`. */
async function signedPayload<T>(
  jws: string,
  typ: string,
  schema: z.ZodType<T>,
  key: VerifyKey,
): Promise<T | null> {
  try {
    const { payload, protectedHeader } = await compactVerify(jws, key, {
      algorithms: ["EdDSA"],
    });
    if (protectedHeader.typ !== typ) return null;
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function verified<T extends { iss: string; project_id: string }>(
  jws: string,
  typ: string,
  schema: z.ZodType<T>,
  ctx: ProofContext,
): Promise<T | null> {
  const p = await signedPayload(jws, typ, schema, ctx.key);
  if (!p || p.iss !== ctx.issuer || p.project_id !== ctx.projectId) {
    return null;
  }
  return p;
}

/** The longest a decision may be claimable after a person makes it. */
const MAX_APPROVED_S = APPROVAL_WINDOWS.approved.max * 60;

/**
 * A person's approval of exactly this statement: the approval, database,
 * key and grant the gateway computed itself, still claimable at `now`, and
 * for no longer than an approval may last.
 */
export async function verifyDecision(
  jws: string,
  ctx: ProofContext & {
    approvalId: string;
    database: string;
    approvalKey: string;
    grantId: string;
    now?: number;
  },
): Promise<DecisionPayload | null> {
  const d = await verified(jws, APPROVAL_JWS_TYPE, DecisionPayloadSchema, ctx);
  if (
    !d ||
    d.approval_id !== ctx.approvalId ||
    d.database !== ctx.database ||
    d.approval_key !== ctx.approvalKey ||
    d.grant_id !== ctx.grantId ||
    d.expires_at * 1000 <= (ctx.now ?? Date.now()) - SKEW_MS ||
    (d.expires_at - d.iat) * 1000 > MAX_APPROVED_S * 1000 + SKEW_MS
  ) {
    return null;
  }
  return d;
}

/** The cloud's claim of that approval, for this gateway's nonce. */
export async function verifyClaim(
  jws: string,
  ctx: ProofContext & { approvalId: string; nonce: string },
): Promise<ClaimPayload | null> {
  const c = await verified(jws, CLAIM_JWS_TYPE, ClaimPayloadSchema, ctx);
  if (!c || c.approval_id !== ctx.approvalId || c.nonce !== ctx.nonce)
    return null;
  return c;
}

/** A grant's taint as the cloud holds it, for this gateway's nonce. */
export async function verifyTaint(
  jws: string,
  ctx: ProofContext & { grantId: string; nonce: string },
): Promise<TaintPayload | null> {
  const t = await verified(jws, TAINT_JWS_TYPE, TaintPayloadSchema, ctx);
  if (!t || t.grant_id !== ctx.grantId || t.nonce !== ctx.nonce) return null;
  return t;
}

/**
 * The cloud's ack of an audit batch from this gateway's file, for its nonce
 * and the body's hash: an ack of a batch cut or changed on the way covers
 * other bytes, and acks nothing.
 */
export async function verifyAuditAck(
  jws: string,
  ctx: ProofContext & {
    gatewayId: string;
    instance: string;
    nonce: string;
    bodySha256: string;
  },
): Promise<AuditAckPayload | null> {
  const a = await verified(jws, AUDIT_ACK_JWS_TYPE, AuditAckPayloadSchema, ctx);
  if (
    !a ||
    a.gateway_id !== ctx.gatewayId ||
    a.instance !== ctx.instance ||
    a.nonce !== ctx.nonce ||
    a.body_sha256 !== ctx.bodySha256
  ) {
    return null;
  }
  return a;
}

/**
 * Where the cloud's relay is, for setup's nonce: no project yet, so it binds
 * the issuer only. `key` is the one the enrollment token pins.
 */
export async function verifyRelay(
  jws: string,
  ctx: { key: VerifyKey; issuer: string; nonce: string },
): Promise<RelayPayload | null> {
  const r = await signedPayload(
    jws,
    RELAY_JWS_TYPE,
    RelayPayloadSchema,
    ctx.key,
  );
  if (!r || r.iss !== ctx.issuer || r.nonce !== ctx.nonce) return null;
  return r;
}
