// A linked gateway's identity, from one-time enrollment.
//
// The enrollment token carries a pin: the SHA-256 thumbprint of the cloud's
// bundle-signing key. The gateway generates an Ed25519 key, sends the public
// half with the token, and accepts the answer only if the key that signed it
// matches the pin, so a TLS-inspecting proxy can't substitute its own. The
// signed identity names the gateway's OAuth client, its first resource, the
// key it enrolled with and the project's bundle version, below which no
// bundle is ever accepted.

import { readFileSync, writeFileSync } from "node:fs";
import { CORE_FEATURES } from "@midplane/core";
import {
  Ed25519PublicJwkSchema,
  ENROLLMENT_TOKEN_PREFIX,
  EnrollmentTokenSchema,
  EnrollResponseSchema,
  IDENTITY_JWS_TYPE,
  IdentityPayloadSchema,
  LINK_API_PREFIX,
  LINK_FEATURES,
} from "@midplane/protocol";
import {
  calculateJwkThumbprint,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import { z } from "zod";
import { ConfigError, type IdentitySource } from "./config.ts";
import { SERVER_VERSION } from "./tools.ts";

/**
 * Features this gateway reports to the cloud: the core's policy sections,
 * plus `approvals` (it files held writes) and `taint` (it keeps taint in the
 * cloud, shared by every instance).
 */
export const GATEWAY_FEATURES: readonly string[] = [
  ...CORE_FEATURES,
  ...Object.values(LINK_FEATURES),
].sort();

const PrivateEd25519JwkSchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  d: z.string().min(1),
  alg: z.literal("EdDSA").optional(),
  use: z.literal("sig").optional(),
  kid: z.string().optional(),
});

export const GatewayIdentitySchema = z.strictObject({
  v: z.literal(1),
  cloud_url: z.string().min(1),
  project_id: z.string().min(1),
  gateway_id: z.string().min(1),
  client_id: z.string().min(1),
  resource: z.string().min(1),
  /** The cloud's bundle-signing key, as pinned at enrollment. */
  bundle_key: Ed25519PublicJwkSchema,
  /** The project's bundle version at enrollment. */
  bundle_floor: z.number().int().nonnegative(),
  /** This gateway's private key, for its client assertions. Keep it secret. */
  key: PrivateEd25519JwkSchema,
});
export type GatewayIdentity = z.infer<typeof GatewayIdentitySchema>;

export class EnrollmentError extends Error {
  /**
   * The request may have reached the cloud and enrolled the gateway though
   * no answer was taken: it timed out, the connection dropped, or the
   * answer couldn't be believed.
   */
  readonly maybeEnrolled: boolean;
  constructor(message: string, o: { maybeEnrolled?: boolean } = {}) {
    super(message);
    this.name = "EnrollmentError";
    this.maybeEnrolled = o.maybeEnrolled ?? false;
  }
}

/** Node's and undici's codes for a connection that was never made. */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** A TLS handshake that failed, as a certificate refused: before any request. */
const TLS_FAILED =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/** Whether a failed fetch could have sent its request first. */
function maybeSent(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code !== "string") return true;
  return !(NOT_CONNECTED.has(code) || TLS_FAILED.test(code));
}

/** The pin an enrollment token carries, as a base64url thumbprint. */
export function enrollmentPin(token: string): string {
  if (!EnrollmentTokenSchema.safeParse(token).success) {
    throw new EnrollmentError(
      "that is not a Midplane enrollment token (mpe1_…)",
    );
  }
  return Buffer.from(token.slice(ENROLLMENT_TOKEN_PREFIX.length), "base64url")
    .subarray(0, 32)
    .toString("base64url");
}

export interface EnrollOptions {
  cloudUrl: string;
  token: string;
  /** `<public base URL>/mcp` for each URL the gateway answers on. */
  resources: readonly string[];
  name?: string | null;
  /** Ids this gateway serves; the cloud adds any the project lacks. */
  databases?: readonly string[];
  /** Stops waiting for the answer, as a timeout would. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface Enrollment {
  /** What to keep. */
  identity: GatewayIdentity;
  /** The project's name, when the cloud says. */
  projectName: string | null;
  /** The databases the cloud added to the project, when it says. */
  databasesAdded: string[] | null;
}

/** Enroll with the cloud and return the identity to keep. */
export async function enroll(o: EnrollOptions): Promise<Enrollment> {
  const pin = enrollmentPin(o.token);
  const { privateKey, publicKey } = await generateKeyPair("Ed25519", {
    extractable: true,
  });
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x } as const;
  const f = o.fetch ?? fetch;

  let res: Response;
  try {
    res = await f(`${o.cloudUrl}${LINK_API_PREFIX}/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: o.token,
        public_key: publicJwk,
        resources: o.resources,
        ...(o.name ? { name: o.name } : {}),
        version: SERVER_VERSION,
        features: GATEWAY_FEATURES,
        ...(o.databases ? { databases: o.databases } : {}),
      }),
      signal: o.signal
        ? AbortSignal.any([o.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new EnrollmentError(
      `can't reach Midplane Cloud at ${o.cloudUrl}: ${(err as Error).message}`,
      { maybeEnrolled: maybeSent(err) },
    );
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const refusal = body as { error?: unknown; error_description?: unknown };
    const described = refusal?.error_description;
    throw new EnrollmentError(
      `enrollment refused (${res.status}): ${typeof described === "string" ? described : "no reason given"}`,
      // The cloud's own refusal names an error; a proxy's 502 or 504 doesn't.
      {
        maybeEnrolled: res.status >= 500 && typeof refusal?.error !== "string",
      },
    );
  }
  // From here on the cloud said yes: it enrolled the gateway.
  const believed = { maybeEnrolled: true };
  const answer = EnrollResponseSchema.safeParse(body);
  if (!answer.success) {
    throw new EnrollmentError(
      "the cloud's enrollment answer is malformed",
      believed,
    );
  }

  // The pin, before anything the answer says is believed.
  const signingKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: answer.data.signing_key.x,
  } as const;
  if ((await calculateJwkThumbprint(signingKey, "sha256")) !== pin) {
    throw new EnrollmentError(
      "the answer is signed with a key the enrollment token doesn't pin; something between this gateway and Midplane Cloud may be intercepting TLS",
      believed,
    );
  }
  let verified: Awaited<ReturnType<typeof compactVerify>>;
  try {
    verified = await compactVerify(
      answer.data.identity,
      await importJWK(signingKey, "EdDSA"),
      { algorithms: ["EdDSA"] },
    );
  } catch {
    throw new EnrollmentError(
      "the identity's signature doesn't verify against the pinned key",
      believed,
    );
  }
  if (verified.protectedHeader.typ !== IDENTITY_JWS_TYPE) {
    throw new EnrollmentError(
      "the enrollment answer is not an identity",
      believed,
    );
  }
  const identity = IdentityPayloadSchema.safeParse(
    JSON.parse(new TextDecoder().decode(verified.payload)),
  );
  if (!identity.success) {
    throw new EnrollmentError("the signed identity is malformed", believed);
  }
  const id = identity.data;
  if (id.iss !== o.cloudUrl) {
    throw new EnrollmentError(`the identity was issued by ${id.iss}`, believed);
  }
  if (id.resource !== o.resources[0]) {
    throw new EnrollmentError(`the identity is for ${id.resource}`, believed);
  }
  if (id.key_thumbprint !== (await calculateJwkThumbprint(publicJwk))) {
    throw new EnrollmentError(
      "the identity is for another gateway's key",
      believed,
    );
  }
  return {
    identity: {
      v: 1,
      cloud_url: id.iss,
      project_id: id.project_id,
      gateway_id: id.gateway_id,
      client_id: id.client_id,
      resource: id.resource,
      bundle_key: signingKey,
      bundle_floor: id.bundle_version,
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: priv.x as string,
        d: priv.d as string,
      },
    },
    projectName: answer.data.project_name ?? null,
    databasesAdded: answer.data.databases_added ?? null,
  };
}

export function parseIdentity(text: string, where: string): GatewayIdentity {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${where}: not a gateway identity (invalid JSON)`);
  }
  const parsed = GatewayIdentitySchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${where}: not a gateway identity`);
  }
  return parsed.data;
}

/** The stored identity, or null when a file source doesn't exist yet. */
export function readIdentity(source: IdentitySource): GatewayIdentity | null {
  if (source.kind === "env") {
    if (!source.value) {
      throw new ConfigError(
        `environment variable ${source.name} is not set: put the output of \`midplane enroll\` there`,
      );
    }
    return parseIdentity(source.value, source.name);
  }
  let text: string;
  try {
    text = readFileSync(source.path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`cannot read the identity ${source.path}`);
  }
  return parseIdentity(text, source.path);
}

/** An identity as its file holds it. */
export function identityText(identity: GatewayIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

/** Write a new identity, readable by this user only; never overwrites one. */
export function writeIdentity(path: string, identity: GatewayIdentity): void {
  writeFileSync(path, identityText(identity), { mode: 0o600, flag: "wx" });
}
