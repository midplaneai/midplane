// Operator-facing region/DB health probe. Distinct from /api/health
// (Fly's http_service.checks liveness, intentionally minimal). This one
// reaches into Neon for an RTT measurement + indexer lag, returns a
// degraded JSON on failure but ALWAYS 200 — never fail-closes the route,
// since Fly polls /api/health (not this one) for restart decisions.

import { sql } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";

import { bootRegion } from "@/lib/region-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthBody {
  region: "eu" | "us" | "unset";
  neon_rtt_ms: number | null;
  indexer_lag_s: number | null;
  errors: string[];
}

export async function GET(): Promise<Response> {
  const errors: string[] = [];
  let region: HealthBody["region"];
  try {
    region = bootRegion();
  } catch {
    region = "unset";
    errors.push("MIDPLANE_REGION not set");
    return Response.json(
      {
        region,
        neon_rtt_ms: null,
        indexer_lag_s: null,
        errors,
      } satisfies HealthBody,
      { status: 200 },
    );
  }

  let neonRttMs: number | null = null;
  let indexerLagS: number | null = null;
  try {
    const db = getDb(region);
    const start = Date.now();
    await db.execute(sql`SELECT 1`);
    neonRttMs = Date.now() - start;
  } catch (err) {
    errors.push(`neon ping: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const db = getDb(region);
    const rows = (await db.execute(
      sql`SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::float8 AS lag FROM audit_events_index`,
    )) as unknown as { lag: number | null }[];
    indexerLagS = rows[0]?.lag ?? null;
  } catch (err) {
    errors.push(`indexer lag: ${err instanceof Error ? err.message : String(err)}`);
  }

  return Response.json(
    {
      region,
      neon_rtt_ms: neonRttMs,
      indexer_lag_s: indexerLagS,
      errors,
    } satisfies HealthBody,
    { status: 200 },
  );
}
