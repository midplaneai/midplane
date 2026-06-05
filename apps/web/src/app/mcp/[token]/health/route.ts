import { getDb } from "@midplane-cloud/db";
import { resolveByToken } from "@midplane-cloud/router";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";

import { bootRegion } from "@/lib/region-context";

// GET /mcp/<token>/health — bootstrap health probe, served by the web app
// (the same ingress as /mcp/<token> itself). It resolves the token against
// the regional cloud DB and returns: token resolves → 200 {ok, region};
// token unknown → 404. Unlike the proxy path it does NOT spawn a container —
// a cheap "is this token live?" check.
//
// PR2 of mcp_url_auth_security: resolveByToken takes (db, plaintext,
// region, peppers). We load the regional pepper here once per request;
// production deploys can cache at a higher layer if probe traffic gets
// loud, but one decrypt per probe is otherwise fine.

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
