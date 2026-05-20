import { getDb } from "@midplane-cloud/db";
import { resolveByToken } from "@midplane-cloud/router";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";

import { bootRegion } from "@/lib/region-context";

// GET /mcp/<token>/health — bootstrap health probe.
//
// In production this URL resolves to a regional Fly app (midplane-eu,
// midplane-us) which spawns the OSS image. For local dev / Playwright
// E2E we serve it directly from Next.js so the contract surface is the
// same: token resolves → 200; token unknown → 404.
//
// PR2 of mcp_url_auth_security: resolveByToken takes (db, plaintext,
// region, peppers). We load the regional pepper here once per request;
// production deploys can cache at a higher layer if probe traffic gets
// loud, but in dev/E2E one decrypt per probe is fine.

let pepperPromise: Promise<Map<string, Buffer>> | null = null;
function getPeppers(): Promise<Map<string, Buffer>> {
  if (!pepperPromise) {
    pepperPromise = loadPepperFromKms(bootRegion(), process.env);
  }
  return pepperPromise;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const region = bootRegion();
  let peppers: Map<string, Buffer>;
  try {
    peppers = await getPeppers();
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
  const resolved = await resolveByToken(getDb(region), token, region, peppers);
  if (!resolved) {
    return Response.json({ ok: false }, { status: 404 });
  }
  return Response.json({ ok: true, region: resolved.connection.region });
}
