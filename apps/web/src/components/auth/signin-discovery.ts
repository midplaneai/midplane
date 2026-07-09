"use server";

import { headers } from "next/headers";

import {
  checkRateLimit,
  SIGNIN_DISCOVERY_RATE_LIMIT,
  signinDiscoveryKey,
} from "@/lib/rate-limit";
import { getSignInMethods, type SignInMethods } from "@/lib/signin-routing";

// Server action behind the identifier-first sign-in form. After the user types
// their email (cold visits that didn't come through the apex router, which
// already discovers server-side from the signed hint), the client calls this to
// learn which methods that account has, then renders only those.
//
// This is an existence + method oracle, so it's rate-limited by client IP (the
// budget lives with the other rate-limit invariants). On limit or any lookup
// error we return the "unknown" shape — the caller then falls back to the
// generic combined form, which is a safe, non-leaky default (it never asserts
// an account does or doesn't exist).

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

export async function discoverSignInMethods(
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
