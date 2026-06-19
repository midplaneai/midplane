// /mcp — the region-wide, default agent-facing Streamable HTTP endpoint.
//
// This is the URL we lead onboarding with: no project id, no token in the path.
// Cursor / Claude Code / Claude Desktop point here and authenticate over OAuth
// 2.1; the project they reach is the one their credential is bound to at consent
// (one OAuth credential → one project). The sibling `/mcp/<segment>` route still
// serves the explicit per-project address and the plaintext URL-token form.
//
// TWO auth methods share THIS boundary (no path segment to discriminate on, so
// we discriminate on the Authorization header):
//
//   - Bearer PAT (the headless/machine half): `Authorization: Bearer
//     mp_(live|test)_…`. A well-formed Midplane token selects its own project
//     via the HMAC lookup, exactly like the URL-token path — so a CI/cron caller
//     can point at the bare /mcp with one env var and keep the secret out of the
//     URL. Checked BEFORE the OAuth branch so a Midplane token never reaches
//     withMcpAuth.
//
//   - OAuth 2.1 (the default interactive path): no Midplane token present →
//     withMcpAuth validates the OAuth bearer against the Better Auth `mcp`
//     plugin; a missing/invalid bearer returns 401 + WWW-Authenticate, kicking
//     off MCP client discovery → authorize → token. With a valid bearer,
//     proxyMcpOAuthGeneric maps the user to their customer, resolves the
//     credential's bound project, and forwards — stamping the per-agent
//     mcp_token_id the audit log keys on.
//
// Streamable HTTP uses POST, GET, and DELETE — POST for JSON-RPC messages, GET
// to open a notifications stream, DELETE to terminate a session. All three flow
// through the same proxy core.

import { parseToken } from "@midplane-cloud/db";
import { withMcpAuth } from "better-auth/plugins";

import { getAuth } from "@/lib/auth";
import { proxyMcp, proxyMcpOAuthGeneric, type OAuthMcpSession } from "@/lib/proxy";

// Streaming bodies must not be buffered by the platform. Force the route to
// stay on the Node.js runtime (Edge wouldn't reach the OSS container's
// private IPv6 anyway in production).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  // Bearer PAT: `Authorization: Bearer mp_(live|test)_…` → HMAC path. The token
  // selects the project, so a headless caller sets one env var and keeps the
  // secret out of the URL. Only a well-formed Midplane token is intercepted; any
  // other bearer (an OAuth access token) falls through to the OAuth branch below.
  const bearer = bearerToken(req);
  if (bearer && parseToken(bearer)) return proxyMcp(req, bearer);

  // Otherwise require an OAuth bearer. withMcpAuth returns 401 +
  // WWW-Authenticate when the bearer is absent or invalid (the discovery
  // handshake); on success it hands us the access-token record (userId /
  // clientId / scopes), and the bound project is derived from its grants.
  const guarded = withMcpAuth(getAuth(), (r: Request, session: OAuthMcpSession) =>
    proxyMcpOAuthGeneric(r, session),
  );
  return guarded(req);
}

// Extract the credential from `Authorization: Bearer <token>`. Returns null when
// the header is absent or not a Bearer scheme — those route to OAuth (a missing
// bearer becomes the withMcpAuth 401 discovery challenge). Case-insensitive
// scheme; the value is matched against the Midplane token format by the caller.
function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

export { handle as GET, handle as POST, handle as DELETE };
