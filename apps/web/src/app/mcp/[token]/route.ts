// /mcp/<segment> — the agent-facing Streamable HTTP endpoint.
//
// Cursor / Claude Code / Claude Desktop all point at this URL. We forward each
// request to a per-connection OSS container (spawned on demand by the router)
// running with the customer's decrypted DATABASE_URL.
//
// TWO auth methods share this boundary, format-discriminated on the path
// segment (the two namespaces are disjoint, so there's no ambiguity):
//
//   - URL token (legacy/back-compat): `<segment>` is an `mp_(live|test)_…`
//     plaintext token. parseToken() matches its shape → proxyMcp HMAC-validates
//     it (resolveByToken) exactly as before. The pre-OAuth path, kept green.
//
//   - OAuth 2.1 (the credible launch path): `<segment>` is a connection id
//     (a ULID — parseToken() returns null). withMcpAuth validates the OAuth
//     bearer against the Better Auth `mcp` plugin; a missing/invalid bearer
//     returns 401 + WWW-Authenticate, which kicks off MCP client discovery →
//     authorize → token. With a valid bearer, proxyMcpOAuth maps the user to
//     their customer, checks they own the connection, and forwards — stamping
//     the per-agent mcp_token_id the audit log keys on.
//
// Streamable HTTP uses POST, GET, and DELETE — POST for JSON-RPC messages, GET
// to open a notifications stream, DELETE to terminate a session. All three flow
// through the same proxy core.

import { parseToken } from "@midplane-cloud/db";
import { withMcpAuth } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";
import { proxyMcp, proxyMcpOAuth, type OAuthMcpSession } from "@/lib/proxy";

// Streaming bodies must not be buffered by the platform. Force the route to
// stay on the Node.js runtime (Edge wouldn't reach the OSS container's
// private IPv6 anyway in production).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token: segment } = await params;

  // URL-token shape (`mp_(live|test)_…`) → HMAC path, unchanged. A malformed
  // token still routes here and resolveByToken returns the leakage-safe 404.
  if (parseToken(segment)) return proxyMcp(req, segment);

  // Otherwise treat the segment as a connection id and require an OAuth bearer.
  // withMcpAuth returns 401 + WWW-Authenticate when the bearer is absent or
  // invalid (the discovery handshake); on success it hands us the access-token
  // record (userId / clientId / scopes).
  const guarded = withMcpAuth(getAuth(), (r: Request, session: OAuthMcpSession) =>
    proxyMcpOAuth(r, segment, session),
  );
  return guarded(req);
}

export { handle as GET, handle as POST, handle as DELETE };
