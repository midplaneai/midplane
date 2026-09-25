// `midplane gateway` configuration: env → GatewayConfig, refusing to boot on
// anything that would give a gateway a second policy source, a second
// credential channel, or a reachable unauthenticated /mcp.
//
// A gateway's policy arrives ONLY as signed bundles from Midplane Cloud, and its
// database credentials ONLY as MIDPLANE_DSN_* variables the bundle names. So:
//
//   refused  MIDPLANE_POLICY_FILE, DATABASE_URL        a second policy / DSN source
//            INDEXER_TOKEN                             the hosted admin + audit-pull routes
//            MIDPLANE_APPROVAL_URL / _TOKEN            the gate is derived from the link
//            MIDPLANE_TRANSPORT=stdio                  a gateway serves HTTP
//   required MIDPLANE_CLOUD_URL                        where to enroll and pull from
//            MIDPLANE_MASK_SALT (≥ 32 chars)           from the customer's secret
//                                                      manager; never in a bundle
//
// And /mcp binds to loopback only. The engine's HTTP transport has no
// authentication yet — an absent scope header means full access — so until the
// authenticated front door exists a gateway must not be reachable from another
// host. Only a literal loopback address is accepted; `localhost` is a name, and
// what a name resolves to is not a property this check can hold.

import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../config.ts";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 3600;
export const MIN_MASK_SALT_LENGTH = 32;

const REFUSED_ENV = [
  "MIDPLANE_POLICY_FILE",
  "DATABASE_URL",
  "INDEXER_TOKEN",
  "MIDPLANE_APPROVAL_URL",
  "MIDPLANE_APPROVAL_TOKEN",
] as const;

export interface GatewayConfig {
  /** Control-plane origin, e.g. https://eu.app.midplane.ai (no trailing slash). */
  cloudUrl: string;
  /** One-time enrollment token; only read when the state dir holds no identity. */
  enrollToken: string | null;
  stateDir: string;
  name: string;
  /** Poll interval override; null ⇒ the value the enrollment response set. */
  pollSeconds: number | null;
  /** The engine's own config, HTTP on loopback. */
  engine: Config;
}

export class GatewayConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Gateway configuration error:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "GatewayConfigError";
  }
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const problems: string[] = [];
  const set = (k: string): boolean => typeof env[k] === "string" && env[k]!.length > 0;

  for (const k of REFUSED_ENV) {
    if (set(k)) {
      problems.push(
        `${k} is set. A gateway takes its policy only from signed bundles and its database credentials only from MIDPLANE_DSN_* variables; unset ${k}.`,
      );
    }
  }
  if (set("MIDPLANE_TRANSPORT") && env.MIDPLANE_TRANSPORT !== "http") {
    problems.push(`MIDPLANE_TRANSPORT=${env.MIDPLANE_TRANSPORT}: a gateway serves HTTP only.`);
  }

  let cloudUrl = "";
  if (!set("MIDPLANE_CLOUD_URL")) {
    problems.push("MIDPLANE_CLOUD_URL is required (your region's Midplane Cloud origin, e.g. https://eu.app.midplane.ai).");
  } else {
    try {
      cloudUrl = parseCloudUrl(env.MIDPLANE_CLOUD_URL!);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const salt = env.MIDPLANE_MASK_SALT ?? "";
  if (salt.length < MIN_MASK_SALT_LENGTH) {
    problems.push(
      `MIDPLANE_MASK_SALT must be at least ${MIN_MASK_SALT_LENGTH} characters. Generate it once (openssl rand -hex 32), keep it in your secret manager, and give every gateway instance the same value. It is never sent to Midplane Cloud.`,
    );
  }

  const host = env.MIDPLANE_HOST && env.MIDPLANE_HOST.length > 0 ? env.MIDPLANE_HOST : DEFAULT_GATEWAY_HOST;
  if (!isLoopbackAddress(host)) {
    problems.push(
      `MIDPLANE_HOST=${host} is not a loopback address. A gateway's /mcp endpoint has no authentication yet, so it binds to 127.0.0.1 or ::1 only; run the agent on the same host or in the same pod.`,
    );
  }

  let pollSeconds: number | null = null;
  if (set("MIDPLANE_GATEWAY_POLL_SECONDS")) {
    const n = Number(env.MIDPLANE_GATEWAY_POLL_SECONDS);
    if (!Number.isInteger(n) || n < MIN_POLL_SECONDS || n > MAX_POLL_SECONDS) {
      problems.push(`MIDPLANE_GATEWAY_POLL_SECONDS must be an integer between ${MIN_POLL_SECONDS} and ${MAX_POLL_SECONDS}.`);
    } else {
      pollSeconds = n;
    }
  }

  const engine = ConfigSchema.safeParse(
    stripUndefined({
      port: env.PORT,
      host,
      dbPath: env.DB_PATH,
      tenantId: env.MIDPLANE_TENANT_ID,
      transport: "http",
      maskSalt: salt.length > 0 ? salt : undefined,
      maskSourceRewrite: env.MIDPLANE_MASK_SOURCE_REWRITE,
    }),
  );
  if (!engine.success) {
    for (const issue of engine.error.issues) {
      problems.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  if (problems.length > 0 || !engine.success) throw new GatewayConfigError(problems);

  return {
    cloudUrl,
    enrollToken: set("MIDPLANE_ENROLL_TOKEN") ? env.MIDPLANE_ENROLL_TOKEN!.trim() : null,
    stateDir: set("MIDPLANE_GATEWAY_STATE_DIR") ? env.MIDPLANE_GATEWAY_STATE_DIR! : defaultStateDir(),
    name: set("MIDPLANE_GATEWAY_NAME") ? env.MIDPLANE_GATEWAY_NAME! : hostname(),
    pollSeconds,
    engine: engine.data,
  };
}

/** Literal loopback only: 127.0.0.0/8 or ::1 (any spelling). */
export function isLoopbackAddress(host: string): boolean {
  if (isIPv4(host)) return host.split(".")[0] === "127";
  if (!isIPv6(host)) return false;
  try {
    return new URL(`http://[${host}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

/** The control plane's origin. https only, except plain http to this machine
 *  for local development and tests. No path: every route hangs off the origin. */
export function parseCloudUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`MIDPLANE_CLOUD_URL is not a URL: ${raw}`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("MIDPLANE_CLOUD_URL must use https:// (plain http is allowed only for localhost).");
  }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    throw new Error("MIDPLANE_CLOUD_URL must be an origin only, e.g. https://eu.app.midplane.ai");
  }
  return u.origin;
}

function defaultStateDir(): string {
  return existsSync("/.dockerenv") ? "/data/gateway" : join(homedir(), ".midplane", "gateway");
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
