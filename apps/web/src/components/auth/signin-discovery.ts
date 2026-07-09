"use server";

import { rateLimitedSignInMethods } from "@/lib/signin-methods";
import type { SignInMethods } from "@/lib/signin-routing";

// Server action behind the identifier-first sign-in form. After the user types
// their email on a cold visit (one that didn't come through the apex router,
// which discovers server-side from the signed hint), the client calls this to
// learn which methods that account has, then renders only those.
//
// The rate limit + fallback live in rateLimitedSignInMethods so the SSR
// apex-hint path (app/sign-in/page.tsx) shares the exact same budget — the
// discovery oracle can't be reached through one path with the limit and the
// other without it.
export async function discoverSignInMethods(
  email: string,
): Promise<SignInMethods> {
  return rateLimitedSignInMethods(email);
}
