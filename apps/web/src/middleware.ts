import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Public routes: landing + legal pages (/privacy, /terms, /imprint) + Clerk's hosted-
// component routes + the agent-facing MCP endpoint (which authenticates by
// token, not by Clerk session) +
// /api/health (Fly http_service.checks polls this without any session).
// /signup/region is reachable unauthenticated on the apex so a brand-new
// visitor sees the region picker; the page server-renders the picker for
// unauth and the normal Clerk-gated picker for authed users (no rendered
// branch leaks any tenant data either way).
// Everything else requires a signed-in user.
const isPublic = createRouteMatcher([
  "/",
  "/demo",
  "/privacy",
  "/terms",
  "/imprint",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/mcp/(.*)",
  "/api/health",
  "/api/health/(.*)",
  "/signup/region",
]);

// MIDPLANE_REGION pins which regional app this process represents. Set as a
// Fly secret on each regional deploy. Bare process check (not bootRegion())
// so middleware module-eval doesn't throw at build time when the var isn't
// set yet (Next.js evaluates middleware during `next build`).
function thisAppRegion(): "eu" | "us" | null {
  const r = process.env.MIDPLANE_REGION;
  if (r !== "eu" && r !== "us") return null;
  return r;
}

// Apex host. Unauth → /signup/region picker. Auth with region claim →
// redirect to the regional subdomain. Auth without region claim → redirect
// to /signup/region to finish onboarding.
const APEX_HOST = "app.midplane.ai";

// Per-region subdomain hosts. Cross-region redirect builds URLs against
// these.
const REGION_HOST: Record<"eu" | "us", string> = {
  eu: "eu.app.midplane.ai",
  us: "us.app.midplane.ai",
};

// MIDDLEWARE_ENFORCE flag governs the read-path (cross-region redirect)
// behavior only. Signup writes always enforce (upsertCustomerRegion calls
// getDb(region) against the chosen region's DB — that succeeds only on
// the matching regional app, by env-var locality). When false, middleware
// logs cross-region requests but does not 302 — used for the 24h shadow
// period right after deploy so backfill gaps surface as logs without
// breaking traffic.
function enforceEnabled(): boolean {
  return process.env.MIDDLEWARE_ENFORCE !== "false";
}

function readRegionClaim(
  sessionClaims: { org?: { publicMetadata?: { region?: unknown } } } | null,
): "eu" | "us" | null {
  const raw = sessionClaims?.org?.publicMetadata?.region;
  if (raw === "eu" || raw === "us") return raw;
  return null;
}

export default clerkMiddleware(async (auth, req) => {
  const url = new URL(req.url);
  const host = url.host;
  const appRegion = thisAppRegion();

  // Apex unauth: let /signup/region render; everything else redirects to
  // /signup/region so the user lands on the picker. The landing (/) is
  // exempt from every apex redirect — it has no region-specific content
  // and signed-in users may revisit it to share with teammates or
  // re-read the pricing table.
  if (host === APEX_HOST) {
    if (url.pathname === "/") return;
    const { userId, sessionClaims } = await auth();
    if (!userId) {
      // Unauth: only /signup/region renders; other paths bounce to it.
      if (url.pathname !== "/signup/region" && !isPublic(req)) {
        return NextResponse.redirect(new URL("/signup/region", req.url));
      }
      return;
    }
    // Authed on apex: redirect to regional subdomain if we know the region.
    const claim = readRegionClaim(sessionClaims as never);
    if (claim) {
      const target = `https://${REGION_HOST[claim]}${url.pathname}${url.search}`;
      return NextResponse.redirect(target);
    }
    // Authed but no region claim: send to picker.
    if (url.pathname !== "/signup/region") {
      return NextResponse.redirect(new URL("/signup/region", req.url));
    }
    return;
  }

  // Regional subdomain (eu.app / us.app): standard auth.protect for
  // non-public routes, then cross-region redirect if the session's region
  // doesn't match this app.
  if (!isPublic(req)) {
    await auth.protect();
  }

  const { userId, sessionClaims } = await auth();
  if (!userId || !appRegion) {
    // Unauth on a public route, or MIDPLANE_REGION not set (dev/test). Let
    // the request through.
    return;
  }

  const claim = readRegionClaim(sessionClaims as never);

  if (claim === null) {
    // Authenticated user with no region in session. Three cases:
    //   1. Clerk session token doesn't expose org.publicMetadata (default),
    //   2. JWT is cached and hasn't picked up a recent publicMetadata write,
    //   3. User genuinely hasn't picked a region yet.
    // We can't tell them apart from the JWT alone, so don't redirect — let
    // the request through and rely on the downstream auth check:
    // (app)/layout.tsx calls currentCustomer() (DB lookup on clerk_org_id);
    // if no row exists, the layout itself redirects to /signup/region.
    // Redirecting here would create a loop in cases 1/2 because the
    // server action that just wrote the DB row + Clerk metadata can't
    // refresh the JWT in the same redirect.
    // Keep the warn — it's still useful as a JWT-staleness/config alert.
    console.warn(
      JSON.stringify({
        level: "warn",
        region: appRegion,
        event: "region.null_metadata",
        userId,
        host,
        path: url.pathname,
      }),
    );
    return;
  }

  if (claim !== appRegion) {
    // Cross-region. Log always; redirect only when enforcement is on. The
    // landing is exempt — it has no region-specific content, so a US user
    // hitting eu.app.midplane.ai/ should see the marketing page rather
    // than getting bounced across regions.
    console.warn(
      JSON.stringify({
        level: "warn",
        region: appRegion,
        event: "region.cross_region",
        sessionRegion: claim,
        appRegion,
        userId,
        host,
        path: url.pathname,
        enforced: enforceEnabled(),
      }),
    );
    if (enforceEnabled() && url.pathname !== "/") {
      const target = `https://${REGION_HOST[claim]}${url.pathname}${url.search}`;
      return NextResponse.redirect(target);
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|.*\\..*).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
