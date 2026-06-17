import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Auth-protection middleware (Better Auth). Optimistic by design: it only
// checks for the EXISTENCE of a session cookie to redirect unauthenticated
// users off protected routes — it does NOT validate the session (that would
// need a DB call; Next 15.1 middleware runs on the Edge runtime). Real
// validation happens downstream: (app)/layout.tsx calls currentCustomer()
// (a DB lookup) and redirects to /signup/region when there's no row.
//
// REGION ROUTING IS DEFERRED. The old middleware redirected apex → regional
// subdomain and cross-region requests using a Clerk JWT region claim. That
// fast-path returns in a later step as a dedicated SIGNED region cookie
// (edge-verifiable, no DB, decoupled from auth). Until then region correctness
// still holds via the currentCustomer() DB fallback above — the eng-plan
// region spike confirmed the pre-DB read was never a hard requirement.

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

export default function middleware(req: NextRequest): NextResponse {
  const { pathname } = new URL(req.url);

  if (isPublic(pathname)) return NextResponse.next();

  // getSessionCookie only checks existence — see the file header. Not a
  // security boundary on its own; the page/layout validates the session.
  const sessionCookie = getSessionCookie(req);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
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
