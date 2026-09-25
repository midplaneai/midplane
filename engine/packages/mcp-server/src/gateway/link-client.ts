// HTTP client for the gateway → control plane link. Every call is outbound and
// starts here; nothing on the control plane ever dials a gateway.
//
// Each request carries a fresh request token signed by the gateway key and bound
// to that request's method, path and body (request-token.ts). Redirects are
// never followed — a token is bound to one path, and a redirect is either a
// misconfiguration or someone steering the gateway — every call has a deadline,
// and every response body is read with a size cap. Results are values, not
// throws, so the pull loop can tell "nothing new", "here is a bundle" and each
// kind of failure apart. Routes and status conventions live in wire.ts.

import type { KeyObject } from "node:crypto";
import { readCapped } from "../read-capped.ts";
import { MAX_BUNDLE_BYTES } from "./bundle.ts";
import { mintEnrollmentProof, mintRequestToken } from "./request-token.ts";
import {
  BUNDLE_PATH,
  ENROLL_PATH,
  HEARTBEAT_PATH,
  LINK_ERROR,
  MAX_LINK_RESPONSE_BYTES,
  bundleEtag,
} from "./wire.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export interface LinkFailure {
  kind: "error";
  /** HTTP status, or null when no response arrived (network, timeout). */
  status: number | null;
  /** The control plane's `error` code when it sent one (see LINK_ERROR), or
   *  the client's own: `redirect` (a 3xx, never followed) and `oversize`. */
  code: string | null;
  message: string;
  /** The control plane's clock, when it reported one (clock_skew). */
  serverTime: number | null;
}

export type BundleFetch =
  | { kind: "not_modified" }
  | { kind: "no_bundle" }
  | { kind: "bundle"; jws: string }
  | LinkFailure;

export interface GatewaySigner {
  gatewayId: string;
  /** The pinned issuer — the audience of every request token. */
  audience: string;
  privateKey: KeyObject;
}

export class LinkClient {
  constructor(
    private readonly cloudUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** POST enroll, proving possession of the key being registered. Returns the
   *  signed enrollment response (verify it with verifyEnrollmentResponse). */
  async enroll(
    body: Record<string, unknown>,
    key: { privateKey: KeyObject; publicKeyRaw: Uint8Array },
  ): Promise<{ kind: "enrolled"; jws: string } | LinkFailure> {
    const text = JSON.stringify(body);
    const proof = mintEnrollmentProof({
      audience: this.cloudUrl,
      method: "POST",
      path: ENROLL_PATH,
      body: text,
      publicKeyRaw: key.publicKeyRaw,
      privateKey: key.privateKey,
    });
    const res = await this.send("POST", ENROLL_PATH, proof, text);
    if (res.kind === "error") return res;
    if (!res.response.ok) return failure(res.response);
    const jws = await readBody(res.response, MAX_LINK_RESPONSE_BYTES, ENROLL_PATH);
    if (typeof jws !== "string") return jws;
    return { kind: "enrolled", jws: jws.trim() };
  }

  async fetchBundle(signer: GatewaySigner, currentVersion: number | null): Promise<BundleFetch> {
    const token = this.token(signer, "GET", BUNDLE_PATH);
    const headers: Record<string, string> = {};
    if (currentVersion !== null) headers["if-none-match"] = bundleEtag(currentVersion);
    const res = await this.send("GET", BUNDLE_PATH, token, undefined, headers);
    if (res.kind === "error") return res;
    if (res.response.status === 304) return { kind: "not_modified" };
    if (!res.response.ok) {
      const f = await failure(res.response);
      // Nothing published yet is a state, not a failure: no backoff, no warning.
      return f.status === 404 && f.code === LINK_ERROR.noBundle ? { kind: "no_bundle" } : f;
    }
    const jws = await readBody(res.response, MAX_BUNDLE_BYTES, BUNDLE_PATH);
    if (typeof jws !== "string") return jws;
    return { kind: "bundle", jws: jws.trim() };
  }

  async heartbeat(signer: GatewaySigner, body: unknown): Promise<{ kind: "ok" } | LinkFailure> {
    const text = JSON.stringify(body);
    const res = await this.send("POST", HEARTBEAT_PATH, this.token(signer, "POST", HEARTBEAT_PATH, text), text);
    if (res.kind === "error") return res;
    if (res.response.ok) {
      await res.response.body?.cancel().catch(() => undefined);
      return { kind: "ok" };
    }
    return failure(res.response);
  }

  /** Authorization header value for an arbitrary signed call (the approval
   *  gate builds its own requests and asks for this per call). */
  authorization(signer: GatewaySigner, method: string, path: string, body?: string): string {
    return `Bearer ${this.token(signer, method, path, body)}`;
  }

  private token(signer: GatewaySigner, method: string, path: string, body?: string): string {
    return mintRequestToken({
      gatewayId: signer.gatewayId,
      audience: signer.audience,
      method,
      path,
      body,
      privateKey: signer.privateKey,
    });
  }

  private async send(
    method: string,
    path: string,
    token: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ kind: "response"; response: Response } | LinkFailure> {
    try {
      const response = await this.fetchImpl(`${this.cloudUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": this.userAgent,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel().catch(() => undefined);
        return {
          kind: "error",
          status: response.status,
          code: "redirect",
          message: `control plane answered ${path} with a redirect (${response.status}); a gateway never follows redirects`,
          serverTime: null,
        };
      }
      return { kind: "response", response };
    } catch (err) {
      return {
        kind: "error",
        status: null,
        code: null,
        message: `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`,
        serverTime: null,
      };
    }
  }
}

/** A 2xx body, or the failure reading it: over the cap, or a stream that broke
 *  mid-body (a reset, the request deadline). Either way the poll loop sees a
 *  LinkFailure and backs off, the same as a failed request. */
async function readBody(res: Response, max: number, path: string): Promise<string | LinkFailure> {
  let text: string | null;
  try {
    text = await readCapped(res, max);
  } catch (err) {
    return {
      kind: "error",
      status: null,
      code: null,
      message: `control plane response to ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      serverTime: null,
    };
  }
  if (text !== null) return text;
  return {
    kind: "error",
    status: null,
    code: "oversize",
    message: `control plane response to ${path} exceeded the size limit`,
    serverTime: null,
  };
}

async function failure(res: Response): Promise<LinkFailure> {
  let code: string | null = null;
  let serverTime: number | null = null;
  const text = await readCapped(res, MAX_LINK_RESPONSE_BYTES).catch(() => null);
  try {
    const body = JSON.parse(text ?? "") as Record<string, unknown>;
    if (typeof body.error === "string") code = body.error;
    if (typeof body.server_time === "number") serverTime = body.server_time;
  } catch {
    // not JSON — status alone
  }
  return {
    kind: "error",
    status: res.status,
    code,
    message: `control plane returned HTTP ${res.status}${code ? ` (${code})` : ""}`,
    serverTime,
  };
}
