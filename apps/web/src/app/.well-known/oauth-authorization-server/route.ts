import { oAuthDiscoveryMetadata } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";

// OAuth 2.1 authorization-server discovery (RFC 8414), served at the ORIGIN
// root. The Better Auth `mcp` plugin already serves this under its basePath
// (/api/auth/.well-known/oauth-authorization-server) and withMcpAuth points
// there via WWW-Authenticate, but some MCP clients ignore that header and probe
// the root path directly — so we mirror it here. The body is identical
// (issuer + authorize/token/register/jwks endpoints).
//
// getAuth() is called INSIDE the handler so the regional DB binding resolves at
// request time, not at build/module-eval (matches app/api/auth/[...all]).
// Lives under /.well-known/* which middleware skips (the dotted path is
// excluded by the matcher), so it's reachable unauthenticated by design.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return oAuthDiscoveryMetadata(getAuth())(req);
}
