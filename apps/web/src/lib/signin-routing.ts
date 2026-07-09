import "server-only";

import { eq, sql } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { account, user } from "@midplane-cloud/db/auth-schema";

import { bootRegion } from "./region-context";
import { otherRegion, type RoutableRegion } from "./region-routing";

// Sign-in region routing for the apex (app.midplane.ai).
//
// Auth is region-resident: an account lives in exactly ONE regional DB, and
// each app can only reach its own (getDb('us') from the EU app THROWS — the
// env-var locality guard). So there is NO central directory to look an email up
// in, and no cross-region query is possible. But there are exactly TWO regions
// and the apex IS the EU app, so we resolve by ELIMINATION: check this app's own
// (EU) user table; a hit is EU, a miss is the other region (US). No cross-region
// call, no shared store.
//
// ASSUMPTION: exactly two regions. If a third region is ever added, "miss ⇒ the
// other one" no longer holds and this must become a real directory or a
// cross-region existence probe (each region owns its own users, queried over an
// authenticated internal endpoint). Documented so the assumption is visible.

/** Does an account with this email exist in THIS app's regional DB?
 *  Case-insensitive (Better Auth stores emails lowercased, but normalize both
 *  sides defensively). */
export async function emailExistsInThisRegion(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const rows = await getDb(bootRegion())
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1);
  return rows.length > 0;
}

/** Resolve which regional app owns the account for `email`, from the apex.
 *  Reads only this (EU) app's DB; a miss routes to the other region by
 *  elimination. A non-existent email routes to the other region too, so the
 *  redirect target doesn't reveal whether an account exists here — the password
 *  step on the destination fails generically. */
export async function resolveSignInRegionOnApex(
  email: string,
): Promise<RoutableRegion> {
  const here: RoutableRegion = bootRegion() === "us" ? "us" : "eu";
  return (await emailExistsInThisRegion(email)) ? here : otherRegion(here);
}

/** Which sign-in methods an email's account actually has, in THIS region.
 *  Drives the identifier-first sign-in UI: once we know the email we render
 *  only the methods that account can use — a user who signed up with Google
 *  never sees a password field they never set, and a password user isn't
 *  offered a Google button that would fork a second identity.
 *
 *  Better Auth stores one `account` row per linked method: providerId
 *  `credential` = an email/password account, `google` = a linked Google
 *  identity (an account can have both). `exists` is keyed off the user row so
 *  an account with only some other provider (e.g. SSO) still reports existing
 *  and the UI can fall back to a generic form rather than a dead end.
 *
 *  Region-resident, same as emailExistsInThisRegion: an account that signs in
 *  here IS in this region, so a single-region lookup is complete. Callers that
 *  expose this to unauthenticated input MUST rate-limit — it's an existence +
 *  method oracle (see components/auth/signin-discovery.ts). */
export interface SignInMethods {
  /** An account with this email exists in this region. */
  exists: boolean;
  /** Has an email/password credential (providerId = "credential"). */
  hasPassword: boolean;
  /** Has a linked Google identity (providerId = "google"). */
  hasGoogle: boolean;
}

export async function getSignInMethods(email: string): Promise<SignInMethods> {
  const normalized = email.trim().toLowerCase();
  const none: SignInMethods = {
    exists: false,
    hasPassword: false,
    hasGoogle: false,
  };
  if (!normalized) return none;
  // LEFT JOIN so a user with zero account rows still returns one row (exists),
  // and a user with several returns one row per linked provider.
  const rows = await getDb(bootRegion())
    .select({ providerId: account.providerId })
    .from(user)
    .leftJoin(account, eq(account.userId, user.id))
    .where(sql`lower(${user.email}) = ${normalized}`);
  if (rows.length === 0) return none;
  const providers = new Set(rows.map((r) => r.providerId).filter(Boolean));
  return {
    exists: true,
    hasPassword: providers.has("credential"),
    hasGoogle: providers.has("google"),
  };
}
