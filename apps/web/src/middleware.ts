import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import {
  APEX_HOST,
  REGION_HOST,
  verifyRegionCookie,
} from "@/lib/region-routing";

// Auth-protection + region routing middleware (Better Auth).
//
// AUTH: optimistic by design — only checks for the EXISTENCE of a session
// cookie to redirect unauthenticated users off protected routes. It does NOT
// validate the session (that needs a DB call; Next 15.1 middleware runs on the
// Edge runtime). Real validation happens downstream: (app)/layout.tsx calls
// currentCustomer() (a DB lookup) and redirects to /signup/region with no row.
//
// REGION: a dedicated SIGNED region cookie (lib/region-routing) routes an authed
// user from the apex to their regional subdomain and bounces cross-region
// requests — edge-verifiable, no DB, decoupled from auth. The cookie is set at
// region-pick. A cookie-miss for an existing user (fresh browser) falls back to
// the region picker; the residency-safe central email-hash→region pointer that
// makes that seamless is a documented follow-up (see lib/region-routing).

// Public routes: landing + legal pages, the region picker (reachable
// unauthenticated so a brand-new visitor sees it). Everything else requires a
// session cookie.
const PUBLIC_EXACT = new Set([
  "/",
  "/demo",
  "/privacy",
  "/terms",
  "/imprint",
  "/signup/region",
]);

// Public path prefixes — the route itself plus any subpath. Covers the auth UI
// (/sign-in, /sign-up), Better Auth's own API (/api/auth/*) which must never be
// gated, the agent-facing MCP endpoint (/mcp/*, token-authed not session-authed),
// and the unauthenticated health check (/api/health — Fly's http_service.checks
// polls it with no session).
const PUBLIC_PREFIXES = ["/sign-in", "/sign-up", "/mcp", "/api/auth", "/api/health"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// MIDPLANE_REGION pins which regional app this process represents. Bare check
// (not bootRegion()) so middleware module-eval doesn't throw at build when the
// var isn't set yet (Next evaluates middleware during `next build`).
function thisAppRegion(): "eu" | "us" | null {
  const r = process.env.MIDPLANE_REGION;
  return r === "eu" || r === "us" ? r : null;
}

// MIDDLEWARE_ENFORCE governs the cross-region REDIRECT only. When "false",
// log-only shadow mode (24h post-deploy so backfill gaps surface as logs
// without breaking traffic). Region WRITES always enforce regardless.
function enforceEnabled(): boolean {
  return process.env.MIDDLEWARE_ENFORCE !== "false";
}

export default async function middleware(
  req: NextRequest,
): Promise<NextResponse> {
  const url = new URL(req.url);
  const host = url.host;
  const { pathname } = url;

  // Apex host: route an authed user to their regional subdomain via the signed
  // region cookie (no DB). The landing is exempt — no region-specific content,
  // and signed-in users may revisit it.
  if (host === APEX_HOST) {
    if (pathname === "/") return NextResponse.next();
    const region = await verifyRegionCookie(req);
    if (region) {
      return NextResponse.redirect(
        `https://${REGION_HOST[region]}${pathname}${url.search}`,
      );
    }
    // No region cookie. Public routes (auth UI, picker) render; everything else
    // goes to the picker. A COOKIE-MISS for an authed existing user (fresh
    // browser) lands here too — re-picking the region re-sets the cookie; the
    // central email-hash→region pointer (deferred) makes it seamless.
    if (isPublic(pathname)) return NextResponse.next();
    return NextResponse.redirect(new URL("/signup/region", req.url));
  }

  // Regional subdomain (and dev single-host, where host !== apex).
  if (isPublic(pathname)) return NextResponse.next();

  const sessionCookie = getSessionCookie(req);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }

  // Cross-region: session is valid but the signed region cookie says the user
  // belongs to a different region than this app serves → redirect to the right
  // regional host. No cookie → fall through (the (app) layout's
  // currentCustomer() DB check is the backstop). In dev, appRegion === cookie
  // region, so this never fires.
  const appRegion = thisAppRegion();
  const region = await verifyRegionCookie(req);
  if (appRegion && region && region !== appRegion) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "region.cross_region",
        appRegion,
        cookieRegion: region,
        host,
        path: pathname,
        enforced: enforceEnabled(),
      }),
    );
    if (enforceEnabled()) {
      return NextResponse.redirect(
        `https://${REGION_HOST[region]}${pathname}${url.search}`,
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|.*\\..*).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
