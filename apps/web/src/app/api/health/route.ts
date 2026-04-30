// Liveness probe for Fly's http_service health check (and any external
// uptime monitor). Intentionally stays "is the process up" — no Postgres
// ping. A DB outage shouldn't fail-closed the proxy: /mcp/<token> traffic
// to already-spawned containers can survive a transient Neon blip, and
// killing every machine on a control-plane DB hiccup would amplify the
// outage instead of containing it.

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
