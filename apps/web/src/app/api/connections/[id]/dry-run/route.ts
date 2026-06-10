// POST /api/connections/:id/dry-run — policy verdicts for the test
// panel. Body: { database, probes? | sql? } (exactly one). The verdict
// is computed by the OSS engine via packages/router's dryRunPolicy
// (acquire → pushPolicy → /admin/dry-run); this route owns auth,
// ownership, rate limiting, request validation, and building the same
// SpawnOptions the MCP proxy builds (every DB decrypted — the engine
// container boots with the full set).
//
// Status mapping:
//   200 — verdicts (the engine answered)
//   400 — engine rejected the request (its error body verbatim, same
//         convention as policy hot-reload errors) or invalid body
//   404 — foreign/unknown connection or database (standard leakage shape)
//   429 — per-connection rate limit (each run can spawn/wake a machine)
//   503 — engine unavailable (spawn failed, timeout, image predates
//         dry-run, INDEXER_TOKEN unset) — retryable
//
// Nothing executes: probes and custom SQL stop at the decision step.
// Tenant context is synthetic (nothing dials the customer DB), so no
// real tenant value is ever needed here.

import { z } from "zod";

import {
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
} from "@midplane-cloud/db";
import type { DryRunRequest } from "@midplane-cloud/router";

import { getConnectionWithDatabasesAndCredentials } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { PROBE_TENANT_VALUE } from "@/lib/probe-matrix";
import { checkRateLimit } from "@/lib/rate-limit";

const Probe = z.object({
  table: z.string().min(1).max(128),
  action: z.enum(["select", "insert", "update", "delete"]),
  cross_tenant: z.boolean().optional(),
});

const Body = z
  .object({
    database: z.string().min(1).max(64),
    probes: z.array(Probe).min(1).max(250).optional(),
    sql: z.string().min(1).max(10_000).optional(),
  })
  .refine((b) => (b.probes === undefined) !== (b.sql === undefined), {
    message: "exactly one of probes | sql",
  });

const RATE_LIMIT = { limit: 6, windowMs: 60_000 };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;

  // Per CONNECTION, not per customer: each run can spawn or wake a Fly
  // machine — this is a cost/abuse cap, not request hygiene.
  const limited = checkRateLimit(`dry-run:${id}`, RATE_LIMIT);
  if (!limited.ok) {
    return Response.json(
      { error: "too many probe runs — try again shortly" },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterS) },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await getConnectionWithDatabasesAndCredentials(customer, id);
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const { connection: conn, databases } = result;
  if (!databases.some((d) => d.name === parsed.data.database)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Same spawn construction as the proxy path (lib/proxy.ts): decrypt
  // every child — the container needs the full set to boot — and fail
  // closed on malformed stored policy.
  const ctx = getMcpProxyContext();
  const spawnDatabases = [];
  for (const cdb of databases) {
    const decrypt = await ctx.resolver.resolve({
      connectionDatabase: cdb,
      region: conn.region,
      customerId: conn.customerId,
    });
    if (!decrypt.ok) {
      return Response.json(
        { error: "engine_unavailable", detail: "credential_unavailable" },
        { status: 503 },
      );
    }
    let tableAccess;
    let tenantScope;
    try {
      tableAccess = parsePolicyOrThrow(cdb.tableAccess);
      tenantScope = parseTenantScopeOrThrow(cdb.tenantScope);
    } catch (err) {
      console.error("[dry-run] invalid stored policy", err);
      return Response.json(
        { error: "engine_unavailable", detail: "invalid stored policy" },
        { status: 503 },
      );
    }
    spawnDatabases.push({
      name: cdb.name,
      connectionDatabaseId: cdb.id,
      dsn: decrypt.plaintext,
      tableAccess,
      tenantScope,
    });
  }

  const request: DryRunRequest = {
    database: parsed.data.database,
    tenant_context: { value: PROBE_TENANT_VALUE },
    ...(parsed.data.probes ? { probes: parsed.data.probes } : {}),
    ...(parsed.data.sql ? { sql: parsed.data.sql } : {}),
  };

  const outcome = await ctx.dryRun(
    {
      connectionId: conn.id,
      region: conn.region,
      databases: spawnDatabases,
    },
    request,
  );

  if (outcome.ok) {
    return Response.json(outcome.response);
  }
  if (outcome.kind === "engine_rejected") {
    return Response.json(
      { error: "engine_rejected", detail: outcome.body },
      { status: 400 },
    );
  }
  return Response.json(
    { error: "engine_unavailable", detail: outcome.detail },
    { status: 503 },
  );
}
