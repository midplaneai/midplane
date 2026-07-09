import "server-only";

import { headers } from "next/headers";

import {
  checkRateLimit,
  SIGNIN_DISCOVERY_RATE_LIMIT,
  signinDiscoveryKey,
} from "./rate-limit";
import { getSignInMethods, type SignInMethods } from "./signin-routing";

// getSignInMethods() behind the per-IP discovery rate limit. Sign-in discovery
// is an existence + method oracle, so EVERY entry point must share one budget:
//  - the cold email step (components/auth/signin-discovery.ts server action), and
//  - the apex-hint SSR path (app/sign-in/page.tsx), which discovers from a signed
//    email hint. That hint is mintable for ANY email by submitting the apex form,
//    so without the limit here an attacker could bypass the server action's limit
//    entirely and scrape the rendered page to enumerate accounts.
//
// Over limit or on any lookup error → the "unknown" shape, so the caller falls
// back to the generic combined form — a safe, non-leaky default that asserts
// nothing about whether an account exists.

const UNKNOWN: SignInMethods = {
  exists: false,
  hasPassword: false,
  hasGoogle: false,
};

function clientIp(h: Headers): string {
  // x-forwarded-for is a comma-separated list; the first entry is the client.
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}

export async function rateLimitedSignInMethods(
  email: string,
): Promise<SignInMethods> {
  const h = await headers();
  const limit = checkRateLimit(
    signinDiscoveryKey(clientIp(h)),
    SIGNIN_DISCOVERY_RATE_LIMIT,
  );
  if (!limit.ok) return UNKNOWN;
  try {
    return await getSignInMethods(email);
  } catch {
    return UNKNOWN;
  }
}
