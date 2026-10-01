// Bundles: a project's complete policy, signed by the cloud at publish.
//
// Verification runs in a fixed order, and a bundle that fails any step is
// rejected and changes nothing: the signature against the key pinned at
// enrollment, its type, the issuer, the project, then its version, which
// must be strictly newer than the newest authentic bundle held (and no
// older than the project's version at enrollment). The same version with
// the same bytes is a repeat; with other bytes, a rejection.
//
// A bundle from a sync must also be the version the sync's freshness proof
// names, so an older authentic bundle can't be replayed, even to a gateway
// that has lost its cache.
//
// An authentic, newer bundle is then assessed. One this gateway can't fully
// enforce (a newer format, an unknown critical field, a policy the core
// refuses) halts the gateway rather than leave the policy it replaced in
// force: the replaced policy may be exactly what someone switched off. So
// does one that registers no URL for this gateway: it could accept no
// token, or tokens for a URL that is no longer its own.

import { validatePolicy } from "@midplane/core";
import {
  BUNDLE_FIELDS,
  BUNDLE_FORMAT,
  BUNDLE_JWS_TYPE,
  type BundlePayload,
  BundlePayloadSchema,
  type DatabasePolicy,
  FRESHNESS_JWS_TYPE,
  FreshnessPayloadSchema,
  MAX_GATEWAY_URLS,
} from "@midplane/protocol";
import { compactVerify } from "jose";
import { z } from "zod";

type VerifyKey = Parameters<typeof compactVerify>[1];

/** What a bundle must carry before it can be ordered against another. */
const EnvelopeSchema = z.looseObject({
  iss: z.string(),
  project_id: z.string(),
  version: z.number().int().positive(),
});

export interface Held {
  version: number;
  jws: string;
}

export interface BundleContext {
  /** The cloud's bundle-signing key, pinned at enrollment. */
  key: VerifyKey;
  issuer: string;
  projectId: string;
  /** The project's bundle version at enrollment: nothing older is accepted. */
  floor: number;
  /** The newest authentic bundle already held, if any. */
  held: Held | null;
}

export type Verified =
  | { kind: "new"; version: number; jws: string; raw: unknown }
  | { kind: "repeat" }
  | { kind: "rejected"; version: number | null; reason: string };

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Steps one to five: is this an authentic, newer bundle for this project? */
export async function verifyBundle(
  jws: string,
  ctx: BundleContext,
): Promise<Verified> {
  let result: Awaited<ReturnType<typeof compactVerify>>;
  try {
    result = await compactVerify(jws, ctx.key, { algorithms: ["EdDSA"] });
  } catch {
    return {
      kind: "rejected",
      version: null,
      reason: "its signature doesn't verify against the pinned signing key",
    };
  }
  if (result.protectedHeader.typ !== BUNDLE_JWS_TYPE) {
    return {
      kind: "rejected",
      version: null,
      reason: "it is signed, but not as a bundle",
    };
  }
  const raw = decodeJson(result.payload);
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return {
      kind: "rejected",
      version: null,
      reason: "it has no issuer, project or version",
    };
  }
  const { iss, project_id: project, version } = envelope.data;
  if (iss !== ctx.issuer) {
    return { kind: "rejected", version, reason: `it was issued by ${iss}` };
  }
  if (project !== ctx.projectId) {
    return { kind: "rejected", version, reason: "it is for another project" };
  }
  if (version < ctx.floor) {
    return {
      kind: "rejected",
      version,
      reason: `version ${version} is older than the project's at enrollment (${ctx.floor})`,
    };
  }
  if (ctx.held) {
    if (version === ctx.held.version) {
      return jws === ctx.held.jws
        ? { kind: "repeat" }
        : {
            kind: "rejected",
            version,
            reason: `it reuses version ${version} with different contents`,
          };
    }
    if (version < ctx.held.version) {
      return {
        kind: "rejected",
        version,
        reason: `version ${version} is older than the enforced ${ctx.held.version}`,
      };
    }
  }
  return { kind: "new", version, jws, raw };
}

/** An http(s) resource URL `<base>/mcp`, as the cloud registers them. */
function isResourceUrl(r: string): boolean {
  if (!URL.canParse(r)) return false;
  const url = new URL(r);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.endsWith("/mcp")
  );
}

export interface GatewayAbilities {
  /** Database ids this gateway has a connection for. */
  databases: ReadonlySet<string>;
  hasSalt: boolean;
  /** This gateway's id, which the bundle lists its registered URLs under. */
  gatewayId: string;
}

export type Assessment =
  | {
      kind: "enforce";
      payload: BundlePayload;
      policies: Map<string, DatabasePolicy>;
      /** The URLs registered for this gateway; null in an older bundle. */
      resources: string[] | null;
    }
  | { kind: "paused"; payload: BundlePayload; resources: string[] | null }
  | { kind: "halt"; reason: string };

/** Whether an authentic bundle can be enforced here, and how. */
export function assessBundle(
  raw: unknown,
  abilities: GatewayAbilities,
): Assessment {
  const v = (raw as { v?: unknown }).v;
  if (v !== BUNDLE_FORMAT) {
    return {
      kind: "halt",
      reason: `the bundle uses format ${String(v)}, which this gateway doesn't understand. Upgrade the gateway.`,
    };
  }
  const crit = (raw as { crit?: unknown }).crit;
  if (Array.isArray(crit)) {
    const unknown = crit.filter(
      (f) => typeof f !== "string" || !BUNDLE_FIELDS.has(f),
    );
    if (unknown.length > 0) {
      return {
        kind: "halt",
        reason: `the bundle needs fields this gateway doesn't understand (${unknown.map(String).join(", ")}). Upgrade the gateway.`,
      };
    }
  }
  const parsed = BundlePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "halt",
      reason: `the bundle is malformed (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}).`,
    };
  }
  const payload = parsed.data;
  if (payload.jwks.keys.length === 0) {
    return { kind: "halt", reason: "the bundle carries no token keys." };
  }
  let resources: string[] | null = null;
  if (payload.gateways) {
    const mine = payload.gateways[abilities.gatewayId]?.resources ?? [];
    if (mine.length === 0) {
      return {
        kind: "halt",
        reason:
          "the bundle registers no URL for this gateway. Register one on the project page.",
      };
    }
    const bad = mine.find((r) => !isResourceUrl(r));
    if (bad !== undefined || mine.length > MAX_GATEWAY_URLS) {
      return {
        kind: "halt",
        reason: `the bundle registers URLs this gateway can't answer on (${bad ?? `more than ${MAX_GATEWAY_URLS}`}).`,
      };
    }
    resources = mine;
  }
  if (payload.paused) return { kind: "paused", payload, resources };

  const policies = new Map<string, DatabasePolicy>();
  for (const [id, policy] of Object.entries(payload.databases)) {
    const checked = validatePolicy(policy);
    if (!checked.ok) {
      return {
        kind: "halt",
        reason: `the policy for database "${id}" can't be enforced (${checked.errors.join("; ")}). Upgrade the gateway.`,
      };
    }
    if (
      abilities.databases.has(id) &&
      Object.keys(checked.policy.masks).length > 0 &&
      !abilities.hasSalt
    ) {
      return {
        kind: "halt",
        reason: `database "${id}" has masks, and this gateway has no mask_salt configured.`,
      };
    }
    policies.set(id, checked.policy);
  }
  return { kind: "enforce", payload, policies, resources };
}

/**
 * The latest version a sync's freshness proof names for this nonce, or null
 * when the proof is missing, forged, stale or for another project.
 */
export async function verifyFreshness(
  jws: string | undefined,
  ctx: { key: VerifyKey; issuer: string; projectId: string; nonce: string },
): Promise<number | null> {
  if (!jws) return null;
  try {
    const { payload, protectedHeader } = await compactVerify(jws, ctx.key, {
      algorithms: ["EdDSA"],
    });
    if (protectedHeader.typ !== FRESHNESS_JWS_TYPE) return null;
    const proof = FreshnessPayloadSchema.safeParse(decodeJson(payload));
    if (
      !proof.success ||
      proof.data.iss !== ctx.issuer ||
      proof.data.project_id !== ctx.projectId ||
      proof.data.nonce !== ctx.nonce
    ) {
      return null;
    }
    return proof.data.version;
  } catch {
    return null;
  }
}
