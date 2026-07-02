import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { user } from "@midplane-cloud/db/auth-schema";

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
