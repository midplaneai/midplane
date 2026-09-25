// Signed approval outcomes: the control plane's answer to a held write.
//
// In gateway mode the answer to POST approvals is a compact JWS signed with the
// same pinned bundle key as a policy bundle:
//
//   header  { alg: EdDSA, typ: "midplane-approval+jws", kid }
//   payload { v, iss, project_id, gateway_id, query_id, sql_sha256, iat, exp,
//             outcome: { status, by?, note?, approval_id?, expires_at?, review_url? } }
//
// "approved" loosens enforcement for one statement — the held write runs — so
// it gets the same guarantee a bundle does: a TLS-intercepting proxy can't
// manufacture one. The binding to this gateway, this attempt (`query_id`, a
// fresh ULID per statement attempt) and these exact SQL bytes means a captured
// "approved" can't be replayed for a different statement or a later attempt,
// and `exp` bounds how long it can be presented at all.
//
// The read-only status route (check_approval) stays plain JSON: it never
// executes anything — the agent must re-run the statement, and that re-run's
// answer is the signed one.

import { createHash, type KeyObject } from "node:crypto";
import { JwsError, checkHeader, parseJsonObject, parseJws, signJws, verifyJws } from "./jws.ts";
import { MAX_CLOCK_SKEW_S } from "./request-token.ts";

export const APPROVAL_TYP = "midplane-approval+jws";
/** Longest validity an approval outcome may claim. */
export const MAX_APPROVAL_OUTCOME_LIFETIME_S = 300;
const APPROVAL_FORMAT_VERSION = 1;
/** Largest approval outcome (the signed form). The approval gate reads answers
 *  with this cap, so the control plane can't sign one a gateway won't read. */
export const MAX_APPROVAL_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Epoch milliseconds after 2001: an `expires_at` in seconds is a mistake.
const MIN_EPOCH_MS = 1e12;

export class ApprovalOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalOutcomeError";
  }
}

/** sha256 of the statement's exact UTF-8 bytes, hex. */
export function sqlSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** The approval gate's wire outcome, snake_case as it travels (approval-gate.ts
 *  parseOutcome reads it). `expires_at` is milliseconds since the epoch. */
export type ApprovalOutcomeWire =
  | { status: "approved" | "denied"; by: string | null; note: string | null }
  | { status: "expired" }
  | { status: "pending"; approval_id: string; expires_at: number; review_url?: string };

export interface ApprovalOutcomeClaims {
  iss: string;
  project_id: string;
  gateway_id: string;
  query_id: string;
  sql_sha256: string;
  iat: number;
  exp: number;
  outcome: ApprovalOutcomeWire;
}

/** Control-plane side. Refuses to sign what the gateway would refuse to read,
 *  so a malformed outcome fails where it is made, not as "approval unavailable"
 *  on a customer's gateway. */
export function encodeApprovalOutcome(
  claims: ApprovalOutcomeClaims,
  signer: { kid: string; privateKey: KeyObject },
): string {
  const bad = malformedClaim(claims);
  if (bad) throw new Error(`approval outcome ${bad}`);
  const jws = signJws(
    { alg: "EdDSA", typ: APPROVAL_TYP, kid: signer.kid },
    JSON.stringify({ v: APPROVAL_FORMAT_VERSION, ...claims }),
    signer.privateKey,
  );
  if (jws.length > MAX_APPROVAL_BYTES) {
    throw new Error(`approval outcome exceeds ${MAX_APPROVAL_BYTES} bytes; shorten the note`);
  }
  return jws;
}

function malformedClaim(c: ApprovalOutcomeClaims): string | null {
  for (const k of ["iss", "project_id", "gateway_id", "query_id"] as const) {
    if (typeof c[k] !== "string" || c[k].length === 0) return `${k} is missing`;
  }
  if (typeof c.sql_sha256 !== "string" || !SHA256_HEX.test(c.sql_sha256)) return "sql_sha256 must be sqlSha256(sql)";
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) return "iat and exp must be integers (seconds)";
  if (c.exp <= c.iat || c.exp - c.iat > MAX_APPROVAL_OUTCOME_LIFETIME_S) {
    return `lifetime must be 1–${MAX_APPROVAL_OUTCOME_LIFETIME_S} s`;
  }
  const o = c.outcome as Record<string, unknown>;
  switch (o?.status) {
    case "approved":
    case "denied":
    case "expired":
      return null;
    case "pending":
      if (typeof o.approval_id !== "string" || o.approval_id.length === 0) return "pending outcome needs approval_id";
      if (!Number.isSafeInteger(o.expires_at) || (o.expires_at as number) < MIN_EPOCH_MS) {
        return "pending outcome needs expires_at in ms since the epoch";
      }
      return null;
    default:
      return "outcome.status must be approved, denied, expired or pending";
  }
}

export interface ApprovalOutcomeExpectations {
  signer: { kid: string; publicKey: KeyObject };
  issuer: string;
  projectId: string;
  gatewayId: string;
  queryId: string;
  sql: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
}

/** Gateway side: the verified outcome object, ready for the gate's parser.
 *  Throws ApprovalOutcomeError for anything else — which the gate turns into
 *  "approval unavailable", never into a decision. */
export function verifyApprovalOutcome(jws: string, expect: ApprovalOutcomeExpectations): Record<string, unknown> {
  let parsed;
  try {
    parsed = parseJws(jws.trim(), MAX_APPROVAL_BYTES);
    checkHeader(parsed.header, { typ: APPROVAL_TYP, keyParam: "kid" });
  } catch (err) {
    if (err instanceof JwsError) throw new ApprovalOutcomeError(`approval outcome: ${err.message}`);
    throw err;
  }
  if (parsed.header.kid !== expect.signer.kid) {
    throw new ApprovalOutcomeError("approval outcome is not signed by the pinned key");
  }
  if (!verifyJws(parsed, expect.signer.publicKey)) {
    throw new ApprovalOutcomeError("approval outcome signature does not verify against the pinned key");
  }

  let p: Record<string, unknown>;
  try {
    p = parseJsonObject(parsed.payload, "approval outcome payload");
  } catch (err) {
    throw new ApprovalOutcomeError((err as Error).message);
  }
  if (p.v !== APPROVAL_FORMAT_VERSION) {
    throw new ApprovalOutcomeError(`approval outcome format v${String(p.v)} is not supported; upgrade the gateway`);
  }
  if (p.iss !== expect.issuer || p.project_id !== expect.projectId || p.gateway_id !== expect.gatewayId) {
    throw new ApprovalOutcomeError("approval outcome is for a different control plane, project or gateway");
  }
  if (p.query_id !== expect.queryId || p.sql_sha256 !== sqlSha256(expect.sql)) {
    throw new ApprovalOutcomeError("approval outcome is for a different statement");
  }
  const { iat, exp, outcome } = p;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) {
    throw new ApprovalOutcomeError("approval outcome is missing iat or exp");
  }
  const iatN = iat as number;
  const expN = exp as number;
  if (expN <= iatN || expN - iatN > MAX_APPROVAL_OUTCOME_LIFETIME_S) {
    throw new ApprovalOutcomeError("approval outcome lifetime is out of range");
  }
  const now = Math.floor(expect.now ?? Date.now() / 1000);
  if (iatN > now + MAX_CLOCK_SKEW_S || expN <= now - MAX_CLOCK_SKEW_S) {
    throw new ApprovalOutcomeError("approval outcome has expired or is not yet valid");
  }
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    throw new ApprovalOutcomeError("approval outcome has no outcome object");
  }
  return outcome as Record<string, unknown>;
}
