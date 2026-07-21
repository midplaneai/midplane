import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import {
  APEX_HOST,
  REGION_HOST,
  verifyRegionCookie,
} from "@/lib/region-routing";
import { isSelfHost } from "@/lib/self-host";

// Auth-protection + region routing middleware (Better Auth).
//
// AUTH: optimistic by design — only checks for the EXISTENCE of a session
// cookie to redirect unauthenticated users off protected routes. It does NOT
// validate the session (that needs a DB call; Next 15.1 middleware runs on the
// Edge runtime). Real validation happens downstream: (app)/layout.tsx calls
// currentCustomer() (a DB lookup) and redirects to /signup with no row.
//
// REGION: a dedicated SIGNED region cookie (lib/region-routing) routes an authed
// user from the apex to their regional subdomain and bounces cross-region
// requests — edge-verifiable, no DB, decoupled from auth. The cookie is set at
// region-pick. A cookie-miss for an existing user (fresh browser) falls back to
// the region picker; the residency-safe central email-hash→region pointer that
// makes that seamless is a documented follow-up (see lib/region-routing).

// Public routes: the root (redirects to /dashboard) and the region picker
// (reachable unauthenticated so a brand-new visitor sees it). Everything else
// requires a session cookie. The marketing landing + legal pages moved to
// midplane.ai (its own repo).
const PUBLIC_EXACT = new Set(["/", "/signup"]);

// Public path prefixes — the route itself plus any subpath. Covers the auth UI
// (/sign-in, /sign-up), Better Auth's own API (/api/auth/*) which must never be
// gated, the agent-facing MCP endpoint (/mcp/*, token-authed not session-authed),
// the unauthenticated health check (/api/health — Fly's http_service.checks
// polls it with no session), and the teammate invite-accept landing
// (/accept-invitation/<id>) which an invited, not-yet-signed-up user must reach
// pre-auth to sign up + accept (the page validates the invite itself).
//
// The Stripe webhook is /api/auth/stripe/webhook (the @better-auth/stripe plugin
// mounts it inside Better Auth's handler), so it's already public via /api/auth
// — no separate entry. It arrives without a session cookie and verifies its own
// Stripe signature, so it MUST stay outside the session gate.
const PUBLIC_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/accept-invitation",
  "/mcp",
  "/api/auth",
  "/api/health",
];

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
  // Public host, NOT the internal listen host. Behind Fly (and any proxy that
  // terminates TLS and forwards to the app over an internal origin), req.url and
  // req.nextUrl carry that internal host — "localhost:3000" — so
  // `new URL(req.url).host` is never "app.midplane.ai" on the apex. Left as the
  // URL host, the `host === APEX_HOST` branch below silently never fires: the
  // apex falls through to the regional auth-gate, which finds no session cookie
  // (it's host-scoped to the regional subdomain) and bounces every route to
  // /sign-in — so a user logged in on eu.app.midplane.ai looks logged out on
  // app.midplane.ai. The public host survives in the Host header, the same
  // source every server-side headers().get("host") read in the app already
  // trusts (sign-in/page.tsx, signup/page.tsx, forgot/page.tsx). Fall back to
  // the URL host for dev/tests, where the two agree.
  const host = req.headers.get("host") ?? url.host;
  const { pathname } = url;

  // Self-host: one host, one DB, no region routing. Auth-protection only —
  // existence-check the session cookie (real validation is the (app) layout's
  // currentCustomer DB read) and skip ALL region logic: no apex/subdomain, no
  // signed region cookie, no cross-region redirect.
  if (isSelfHost()) {
    if (isPublic(pathname)) return NextResponse.next();
    const sessionCookie = getSessionCookie(req);
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/sign-in", req.url));
    }
    return NextResponse.next();
  }

  // Apex host: route an authed user to their regional subdomain via the signed
  // region cookie (no DB). The root is exempt — it just redirects into the
  // product (/dashboard), which carries its own region routing downstream.
  if (host === APEX_HOST) {
    if (pathname === "/") return NextResponse.next();
    const region = await verifyRegionCookie(req);
    if (region) {
      return NextResponse.redirect(
        `https://${REGION_HOST[region]}${pathname}${url.search}`,
      );
    }
    // No region cookie yet. On the apex the region is chosen BEFORE signup, so
    // send every /sign-up hit — including stray subpaths like /sign-up/region
    // (an easy typo for /signup) — to the picker. The picker routes to the
    // regional subdomain where region-resident signup actually happens; without
    // this, /sign-up renders here on the apex (EU) app and silently pins the new
    // account to EU. /sign-in is deliberately NOT redirected: a returning
    // user's cookie-miss is the deferred email→region pointer problem, not a
    // new-account default, so it still renders and the (app) layout backstops.
    if (pathname === "/sign-up" || pathname.startsWith("/sign-up/")) {
      return NextResponse.redirect(new URL("/signup", req.url));
    }
    // Other public routes (sign-in, Better Auth API, MCP, health) render;
    // everything else goes to the picker. A COOKIE-MISS for an authed existing
    // user (fresh browser) lands here too — re-picking the region re-sets the
    // cookie; the central email-hash→region pointer (deferred) makes it seamless.
    if (isPublic(pathname)) return NextResponse.next();
    return NextResponse.redirect(new URL("/signup", req.url));
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
