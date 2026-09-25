// Policy bundle envelope: the signed, versioned statement a gateway enforces.
//
// Wire form is a compact JWS (jws.ts), signed by the control plane's regional
// bundle key AT PUBLISH and stored signed, so write access to the control
// plane's database alone can never produce a bundle a gateway accepts.
//
//   header  { alg: EdDSA, typ: "midplane-bundle+jws", kid }
//   payload { v, crit, iss, project_id, version, iat, paused, policy }
//
// `policy` is the engine policy YAML exactly as the control plane serialized
// it — the same bytes `midplane server` boots from. It travels as a string
// inside the signed JSON, so the signature covers it byte for byte.
//
// Verification (verifyBundle) sorts every bundle into one of three outcomes:
//
//   reject     not authentic, not ours, or older than what we hold. Enforcement
//              stays exactly as it was. A reject can never loosen, remove or
//              stop enforcement, so nothing that can tamper with a response can
//              use one to do damage.
//   noop       the bundle we already hold, byte for byte.
//   authentic  signed by the pinned key, for this project, newer. The caller
//              persists it and then either enforces it or — when the envelope
//              says something this gateway can't honour — halts. Keeping an
//              older bundle after the customer replaced it would silently drop
//              whatever the new one added.

import { type KeyObject } from "node:crypto";
import {
  JwsError,
  checkHeader,
  parseJsonObject,
  parseJws,
  signJws,
  verifyJws,
} from "./jws.ts";

export const BUNDLE_TYP = "midplane-bundle+jws";
export const BUNDLE_FORMAT_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1024 * 1024;

/** Payload fields a v1 gateway understands. Reported in the heartbeat so the
 *  control plane knows which `crit` names a gateway can honour. */
export const BUNDLE_FIELDS_V1 = [
  "v",
  "crit",
  "iss",
  "project_id",
  "version",
  "iat",
  "paused",
  "policy",
] as const;

const KNOWN_FIELDS: ReadonlySet<string> = new Set(BUNDLE_FIELDS_V1);

export interface BundleClaims {
  v: 1;
  /** Extension fields a gateway MUST understand to enforce this bundle — the
   *  JWS `crit` rule (RFC 7515 §4.1.11) applied to payload fields. Anything not
   *  listed here that a gateway doesn't know is ignored, so a cosmetic field
   *  never halts an old gateway; a security-relevant one is listed and does. */
  crit: string[];
  iss: string;
  project_id: string;
  version: number;
  /** Publish time, seconds since the epoch. */
  iat: number;
  /** Signed kill switch. A paused bundle is authentic and enforceable; the
   *  gateway serves nothing while it holds one. */
  paused: boolean;
  policy: string;
}

export interface BundleSigner {
  kid: string;
  privateKey: KeyObject;
}

/** Sign a bundle. Control-plane side. `extra` exists for fields later envelope
 *  revisions add (and for tests of how today's gateways treat them). */
export function encodeBundle(
  claims: Omit<BundleClaims, "v" | "crit"> & { crit?: string[] },
  signer: BundleSigner,
  extra: Record<string, unknown> = {},
): string {
  if (!isNonEmptyString(claims.iss)) throw new Error("bundle iss is required");
  if (!isNonEmptyString(claims.project_id)) throw new Error("bundle project_id is required");
  if (!isPositiveInt(claims.version)) throw new Error("bundle version must be a positive integer");
  if (!Number.isSafeInteger(claims.iat)) throw new Error("bundle iat must be an integer");
  if (typeof claims.paused !== "boolean") throw new Error("bundle paused must be a boolean");
  if (typeof claims.policy !== "string") throw new Error("bundle policy must be a string");
  for (const k of Object.keys(extra)) {
    if (KNOWN_FIELDS.has(k)) throw new Error(`bundle extra field "${k}" shadows a core field`);
  }
  // Fixed member order keeps the signed bytes predictable for a given input;
  // verification never depends on it (the signature covers what was sent).
  const payload = {
    v: BUNDLE_FORMAT_VERSION,
    crit: claims.crit ?? [],
    iss: claims.iss,
    project_id: claims.project_id,
    version: claims.version,
    iat: claims.iat,
    paused: claims.paused,
    policy: claims.policy,
    ...Object.fromEntries(Object.entries(extra).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const jws = signJws(
    { alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid },
    JSON.stringify(payload),
    signer.privateKey,
  );
  if (jws.length > MAX_BUNDLE_BYTES) {
    throw new Error(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  return jws;
}

export type BundleRejectReason =
  | "oversize"
  | "malformed"
  | "header"
  | "unknown_kid"
  | "signature"
  | "issuer"
  | "project"
  | "rollback"
  | "version_conflict";

export type BundleVerdict =
  | { kind: "reject"; reason: BundleRejectReason; detail: string; version: number | null }
  | { kind: "noop"; version: number }
  | {
      kind: "authentic";
      version: number;
      jws: string;
      envelope:
        | { ok: true; claims: BundleClaims; ignoredFields: string[] }
        | { ok: false; reason: string };
    };

export interface BundleExpectations {
  /** The bundle key pinned at enrollment. */
  signer: { kid: string; publicKey: KeyObject };
  issuer: string;
  projectId: string;
  /** The newest authentic bundle this gateway holds (exact bytes), if any. */
  current: { version: number; jws: string } | null;
  /** Signed floor from the enrollment response: the project's latest version
   *  when this gateway enrolled. A gateway never accepts anything older, even
   *  before its first bundle arrives. */
  minVersion: number;
}

export function verifyBundle(jws: string, expect: BundleExpectations): BundleVerdict {
  const reject = (
    reason: BundleRejectReason,
    detail: string,
    version: number | null = null,
  ): BundleVerdict => ({ kind: "reject", reason, detail, version });

  // 1. Structure + exact header.
  let parsed;
  try {
    parsed = parseJws(jws, MAX_BUNDLE_BYTES);
    checkHeader(parsed.header, { typ: BUNDLE_TYP, keyParam: "kid" });
  } catch (err) {
    if (err instanceof JwsError) {
      return reject(err.code === "oversize" ? "oversize" : err.code === "header" ? "header" : "malformed", err.message);
    }
    throw err;
  }
  if (parsed.header.kid !== expect.signer.kid) {
    return reject("unknown_kid", `bundle signed with key ${String(parsed.header.kid)}, pinned key is ${expect.signer.kid}`);
  }

  // 2. Signature over the exact bytes received.
  if (!verifyJws(parsed, expect.signer.publicKey)) {
    return reject("signature", "bundle signature does not verify against the pinned key");
  }

  // 3. Binding. iss, project_id and version keep their meaning in EVERY envelope
  //    version — they are what makes a bundle ours, for us, and newer — so they
  //    are checked before `v` is even looked at.
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(parsed.payload, "bundle payload");
  } catch (err) {
    return reject("malformed", (err as Error).message);
  }
  const { iss, project_id: projectId, version } = payload;
  if (!isNonEmptyString(iss) || !isNonEmptyString(projectId) || !isPositiveInt(version)) {
    return reject("malformed", "bundle is missing iss, project_id or a positive integer version");
  }
  if (iss !== expect.issuer) {
    return reject("issuer", `bundle issuer ${iss} is not the pinned issuer ${expect.issuer}`, version);
  }
  if (projectId !== expect.projectId) {
    return reject("project", `bundle is for project ${projectId}, this gateway serves ${expect.projectId}`, version);
  }

  // 4. Monotonic version.
  if (expect.current && version === expect.current.version) {
    if (jws === expect.current.jws) return { kind: "noop", version };
    // Two different signed statements under one version number: a control
    // plane bug or a key compromise. Either way, not something to apply.
    return reject("version_conflict", `bundle v${version} differs from the v${version} already held`, version);
  }
  const floor = Math.max(expect.current?.version ?? 0, expect.minVersion);
  if (version < floor) {
    return reject("rollback", `bundle v${version} is older than v${floor}`, version);
  }

  // Authentic, ours, newer. Whether this gateway can honour the envelope is a
  // separate question — the answer to it halts rather than rejects. A v1
  // envelope whose v1 fields are mistyped is the exception: that is a broken
  // statement, not one this gateway is too old to read, so it is rejected like
  // any other malformed bundle.
  const envelope = readEnvelope(payload);
  if ("malformed" in envelope) return reject("malformed", envelope.malformed, version);
  return { kind: "authentic", version, jws, envelope };
}

function readEnvelope(
  payload: Record<string, unknown>,
):
  | { ok: true; claims: BundleClaims; ignoredFields: string[] }
  | { ok: false; reason: string }
  | { malformed: string } {
  const v = payload.v;
  if (v !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `bundle format v${String(v)} is not supported by this gateway (supports v${BUNDLE_FORMAT_VERSION}); upgrade the gateway`,
    };
  }

  const { crit = [], iat, paused, policy } = payload;
  if (!Array.isArray(crit) || crit.some((c) => typeof c !== "string")) {
    return { malformed: "bundle crit must be an array of field names" };
  }
  if (!Number.isSafeInteger(iat)) return { malformed: "bundle iat must be an integer" };
  if (typeof paused !== "boolean") return { malformed: "bundle paused must be a boolean" };
  if (typeof policy !== "string") return { malformed: "bundle policy must be a string" };

  const unknownCrit = (crit as string[]).filter((c) => !KNOWN_FIELDS.has(c));
  if (unknownCrit.length > 0) {
    return {
      ok: false,
      reason: `bundle requires field(s) this gateway does not understand: ${unknownCrit.join(", ")}; upgrade the gateway`,
    };
  }

  const ignoredFields = Object.keys(payload).filter((k) => !KNOWN_FIELDS.has(k)).sort();
  return {
    ok: true,
    claims: {
      v: BUNDLE_FORMAT_VERSION,
      crit: crit as string[],
      iss: payload.iss as string,
      project_id: payload.project_id as string,
      version: payload.version as number,
      iat: iat as number,
      paused,
      policy,
    },
    ignoredFields,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
