"use server";

import { cookies, headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import { bootRegion } from "@/lib/region-context";
import {
  REGION_COOKIE,
  regionCookieOptions,
  signRegionCookieValue,
} from "@/lib/region-routing";
import { isSelfHost } from "@/lib/self-host";

// Accept a workspace invitation, then (cloud) pin the invited user's home-region
// cookie to THIS regional app.
//
// The invite, org, and customer all live in this region: the invite link's host
// routed the user to this regional app and the invitation row is in this region's
// DB. So the invited user's home region IS bootRegion(). A brand-new invited user
// never went through the region picker, so without this cookie their next visit
// to the apex would bounce to the picker; setting it routes them straight to this
// regional subdomain. Self-host has no region routing, so we skip it.
//
// Returns a state object (no throw): reached from a client component that renders
// the error inline (mirrors the new-connection form pattern in AGENTS.md).
export async function acceptInvite(
  invitationId: string,
): Promise<{ error?: string }> {
  try {
    await getAuth().api.acceptInvitation({
      body: { invitationId },
      headers: await headers(),
    });
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message
          ? e.message
          : "Couldn’t accept the invitation. The link may have expired.",
    };
  }

  // Cloud: bootRegion() is "eu" | "us" — exactly RoutableRegion. The narrow
  // keeps it type-safe (and is a no-op fail-safe if the value ever widened).
  if (!isSelfHost()) {
    const region = bootRegion();
    if (region === "eu" || region === "us") {
      const store = await cookies();
      store.set(
        REGION_COOKIE,
        await signRegionCookieValue(region),
        regionCookieOptions(),
      );
    }
  }

  return {};
}
