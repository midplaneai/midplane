import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

// OAuth 2.0 protected-resource metadata (RFC 9728), served at the ORIGIN root.
// withMcpAuth's 401 WWW-Authenticate points MCP clients at
// /api/auth/.well-known/oauth-protected-resource; this root mirror covers
// clients that default to the root path instead. Both routes return the SAME
// body (this helper delegates to the plugin's getMCPProtectedResource endpoint),
// so the `resource` we set on the mcp() plugin (lib/auth.ts) — the MCP-endpoint
// origin, e.g. https://us.midplane.ai — is advertised identically here. It names
// the host agents CONNECT to, NOT this route's issuer host; a strict client
// validates the two match. `authorization_servers` still names the issuer.
//
// See the sibling oauth-authorization-server route for the lazy-getAuth +
// middleware-skip rationale.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return oAuthProtectedResourceMetadata(getAuth())(req);
}
