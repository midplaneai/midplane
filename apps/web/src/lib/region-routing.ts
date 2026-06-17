import type { NextRequest } from "next/server";

// Region routing for the multi-region cloud: a dedicated SIGNED region cookie
// (NOT a Better Auth session claim) plus the apex/subdomain host map.
//
// Why a signed cookie, not the session: region is IMMUTABLE and decoupled from
// auth — the regional DB is chosen by the MIDPLANE_REGION env, not the session.
// The cookie lets the apex route an authed user to their regional subdomain
// with NO DB read and NO JWT-refresh lag, edge-verifiable and tamper-rejecting
// (the spike proved this). Auth data is region-resident, so region must NOT
// live in the session.

export type RoutableRegion = "eu" | "us";

// Apex + per-region hosts. Cross-region / apex→subdomain redirects build URLs
// against these.
export const APEX_HOST = "app.midplane.ai";
export const REGION_HOST: Record<RoutableRegion, string> = {
  eu: "eu.app.midplane.ai",
  us: "us.app.midplane.ai",
};

// The signed region cookie. Scoped to .app.midplane.ai (see regionCookieOptions)
// so the apex AND both regional subdomains can read it. Value is
// `<region>.<base64url-hmac>` so it can't be forged. Region is immutable, so
// it's long-lived.
export const REGION_COOKIE = "mp_region";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5; // 5y — region never changes.

function cookieSecret(): string {
  const s = process.env.MIDPLANE_REGION_COOKIE_SECRET;
  if (!s) throw new Error("MIDPLANE_REGION_COOKIE_SECRET is not set");
  return s;
}

async function hmacKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cookieSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Build the signed cookie value for a region: `<region>.<base64url hmac>`. */
export async function signRegionCookieValue(
  region: RoutableRegion,
): Promise<string> {
  const key = await hmacKey(["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(region),
  );
  return `${region}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** Verify a signed cookie value; returns the region only if the HMAC checks
 *  out (constant-time via crypto.subtle.verify), else null. Edge-compatible —
 *  Web Crypto only, no DB, no Node APIs. */
export async function verifyRegionCookieValue(
  value: string | undefined | null,
): Promise<RoutableRegion | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const region = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (region !== "eu" && region !== "us") return null;
  try {
    const key = await hmacKey(["verify"]);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(region),
    );
    return ok ? region : null;
  } catch {
    // Malformed signature (e.g. atob threw on non-base64 input).
    return null;
  }
}

/** Read + verify the region cookie off a middleware request. */
export async function verifyRegionCookie(
  req: NextRequest,
): Promise<RoutableRegion | null> {
  return verifyRegionCookieValue(req.cookies.get(REGION_COOKIE)?.value);
}

/** Set-Cookie attributes for the region pick. Domain is set only in production
 *  (.app.midplane.ai shares the cookie across apex + subdomains); omitted in
 *  dev/localhost where a parent domain doesn't apply. */
export function regionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  domain?: string;
} {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    ...(isProd ? { domain: ".app.midplane.ai" } : {}),
  };
}
