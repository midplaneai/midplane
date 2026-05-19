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
    // Indexer freshness = `now() - max(indexer_cursors.last_indexed_at)`
    // across all customers in this region. Matches the lib/audit.ts
    // readStaleness signal: when did the indexer last persist anything,
    // anywhere in this region. (Earlier draft used audit_events_index
    // but that table has no created_at column, and its `ts` field is
    // the event-emission time — an idle customer would always show
    // stale even when the indexer is healthy.) Null when the indexer
    // has never run.
    const db = getDb(region);
    const rows = (await db.execute(
      sql`SELECT EXTRACT(EPOCH FROM (now() - max(last_indexed_at)))::float8 AS lag FROM indexer_cursors`,
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
