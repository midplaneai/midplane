import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes: landing + Clerk's hosted-component routes + the agent-facing
// MCP endpoint (which authenticates by token, not by Clerk session) +
// /api/health (Fly http_service.checks polls this without any session).
// Everything else requires a signed-in user.
const isPublic = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/mcp/(.*)",
  "/api/health",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) {
    await auth.protect();
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
