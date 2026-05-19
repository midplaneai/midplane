import { getDb } from "@midplane-cloud/db";
import { resolveByToken } from "@midplane-cloud/router";

import { bootRegion } from "@/lib/region-context";

// GET /mcp/<token>/health — bootstrap health probe.
//
// In production this URL resolves to a regional Fly app (midplane-eu,
// midplane-us) which spawns the OSS image. For local dev / Playwright
// E2E we serve it directly from Next.js so the contract surface is the
// same: token resolves → 200; token unknown → 404.
//
// The actual /mcp/<token> proxy that forwards JSON-RPC to the spawned
// container is wired in a follow-up PR.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // Local-dev / E2E only — production hits regional data-plane apps directly.
  const resolved = await resolveByToken(getDb(bootRegion()), token);
  if (!resolved) {
    return Response.json({ ok: false }, { status: 404 });
  }
  return Response.json({ ok: true, region: resolved.connection.region });
}
