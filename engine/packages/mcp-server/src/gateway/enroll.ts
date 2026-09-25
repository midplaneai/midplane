// First-boot enrollment: turn a one-time token into a persistent identity.
//
// Order matters:
//   1. an identity already on disk wins — the token is ignored (it has been
//      spent, and may still sit in the deploy config);
//   2. the keypair is written BEFORE calling out, so if the response is lost
//      after the control plane consumed the token, a retry presents the same
//      key and the control plane re-issues the same gateway's response;
//   3. the response is accepted only if it is signed by the key pinned in the
//      token, names this gateway's key, and is well-formed — then, and only
//      then, identity.json is written.

import { hostname } from "node:os";
import type { KeyObject } from "node:crypto";
import type { LinkClient } from "./link-client.ts";
import type { GatewayStateDir, StoredIdentity } from "./state.ts";
import {
  EnrollmentError,
  parseEnrollmentToken,
  verifyEnrollmentResponse,
} from "./protocol.ts";

export interface EnrollInput {
  cloudUrl: string;
  enrollToken: string | null;
  name: string;
  engineVersion: string;
  capabilities: unknown;
}

export interface LoadedIdentity {
  identity: StoredIdentity;
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
  enrolledNow: boolean;
}

export async function ensureIdentity(
  state: GatewayStateDir,
  client: LinkClient,
  input: EnrollInput,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): Promise<LoadedIdentity> {
  const existing = state.readIdentity();
  if (existing) {
    if (input.enrollToken) {
      log.info({ gateway_id: existing.gateway_id }, "already enrolled; MIDPLANE_ENROLL_TOKEN is ignored");
    }
    if (existing.cloud_url !== input.cloudUrl) {
      log.warn(
        { enrolled_against: existing.cloud_url, cloud_url: input.cloudUrl },
        "MIDPLANE_CLOUD_URL differs from the origin this gateway enrolled against",
      );
    }
    const key = state.loadKey();
    return { identity: existing, ...key, enrolledNow: false };
  }

  if (!input.enrollToken) {
    throw new EnrollmentError(
      `This gateway is not enrolled (no identity in ${state.dir}) and MIDPLANE_ENROLL_TOKEN is not set. ` +
        "Create an enrollment token on the project's Gateways card in Midplane Cloud. " +
        "If this gateway was enrolled before, its state directory was not persisted — mount a volume there.",
    );
  }
  const { pin } = parseEnrollmentToken(input.enrollToken);
  const key = state.loadOrCreateKey();

  const res = await client.enroll(
    {
      token: input.enrollToken,
      name: input.name || hostname(),
      engine_version: input.engineVersion,
      capabilities: input.capabilities,
    },
    key,
  );
  if (res.kind === "error") {
    throw new EnrollmentError(`enrollment failed: ${res.message}${enrollHint(res.code)}`);
  }

  const verified = verifyEnrollmentResponse(res.jws, { pin, gatewayPublicKeyRaw: key.publicKeyRaw });
  const identity: StoredIdentity = {
    v: 1,
    gateway_id: verified.gatewayId,
    project_id: verified.projectId,
    cloud_url: input.cloudUrl,
    issuer: verified.issuer,
    signing_key: verified.signingKey,
    min_version: verified.minVersion,
    poll_seconds: verified.pollSeconds,
    enrolled_at: verified.enrolledAt,
  };
  state.writeIdentity(identity);
  log.info(
    { gateway_id: identity.gateway_id, project_id: identity.project_id, min_version: identity.min_version },
    "gateway enrolled",
  );
  return { identity, ...key, enrolledNow: true };
}

function enrollHint(code: string | null): string {
  switch (code) {
    case "enrollment_token_expired":
      return " — the token has expired; create a new one in Midplane Cloud.";
    case "enrollment_token_used":
      return " — the token was already used by another gateway; create a new one.";
    case "enrollment_token_invalid":
      return " — the token is not valid for this control plane (check MIDPLANE_CLOUD_URL's region).";
    default:
      return "";
  }
}
