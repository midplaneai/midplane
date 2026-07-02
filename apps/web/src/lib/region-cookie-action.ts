"use server";

import { cookies } from "next/headers";

import { bootRegion } from "./region-context";
import {
  REGION_COOKIE,
  regionCookieOptions,
  signRegionCookieValue,
} from "./region-routing";
import { isSelfHost } from "./self-host";

// Stamp the signed region cookie for THIS app's region after a successful
// sign-in. Auth is region-resident, so a session can only ever be created on
// the regional app that owns the account — this app's region (bootRegion()) IS
// the user's region. Setting the cookie makes the browser region-sticky: the
// apex then routes it straight to this subdomain (no email-first router, no
// cross-region hop) on every later visit. Same cookie the region picker and
// invite-accept set; this just also covers the returning-user path.
//
// Cloud only (self-host has no region routing). Best-effort — a signing failure
// (e.g. a misconfigured MIDPLANE_REGION_COOKIE_SECRET) must NOT break the
// sign-in it follows; the middleware falls back to the picker without a cookie.
export async function stampRegionCookie(): Promise<void> {
  if (isSelfHost()) return;
  const region = bootRegion();
  if (region !== "eu" && region !== "us") return;
  try {
    const store = await cookies();
    store.set(
      REGION_COOKIE,
      await signRegionCookieValue(region),
      regionCookieOptions(),
    );
  } catch (err) {
    console.error("sign-in: failed to stamp region cookie (continuing)", err);
  }
}
