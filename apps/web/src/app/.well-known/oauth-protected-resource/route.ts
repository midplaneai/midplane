import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

// OAuth 2.0 protected-resource metadata (RFC 9728), served at the ORIGIN root.
// withMcpAuth's 401 WWW-Authenticate points MCP clients at
// /api/auth/.well-known/oauth-protected-resource; this root mirror covers
// clients that default to the root path instead. The body advertises this
// origin as the protected resource and names its authorization server.
//
// See the sibling oauth-authorization-server route for the lazy-getAuth +
// middleware-skip rationale.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return oAuthProtectedResourceMetadata(getAuth())(req);
}
