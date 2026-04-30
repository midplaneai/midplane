// /mcp/<token> — the agent-facing Streamable HTTP endpoint.
//
// Cursor / Claude Code / Claude Desktop all point at this URL. We forward
// each request to a per-token OSS container (spawned on demand by the
// router) running with the customer's decrypted DATABASE_URL.
//
// Streamable HTTP uses POST, GET, and DELETE — POST for JSON-RPC messages,
// GET to open a notifications stream, DELETE to terminate a session. All
// three flow through the same proxy core.

import { proxyMcp } from "@/lib/proxy";

// Streaming bodies must not be buffered by the platform. Force the route to
// stay on the Node.js runtime (Edge wouldn't reach the OSS container's
// private IPv6 anyway in production).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  return proxyMcp(req, token);
}

export { handle as GET, handle as POST, handle as DELETE };
