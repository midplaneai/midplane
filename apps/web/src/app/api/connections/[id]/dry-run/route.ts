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
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
  type DatabaseEntry,
} from "@midplane-cloud/db";
import type { DryRunRequest } from "@midplane-cloud/router";

import { getConnectionWithDatabasesAndCredentials } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import {
  MAX_GUARDRAIL_PROBES,
  MAX_PROBES_PER_RUN,
  PROBE_ACTIONS,
  PROBE_TENANT_VALUE,
} from "@/lib/probe-matrix";
import {
  checkRateLimit,
  DRY_RUN_RATE_LIMIT,
  dryRunKey,
} from "@/lib/rate-limit";

const Probe = z.object({
  table: z.string().min(1).max(128),
  action: z.enum(PROBE_ACTIONS),
  cross_tenant: z.boolean().optional(),
});

const Body = z
  .object({
    database: z.string().min(1).max(64),
    probes: z.array(Probe).min(1).max(MAX_PROBES_PER_RUN).optional(),
    sql: z.string().min(1).max(10_000).optional(),
    // Guardrail checks riding along with a probe run: literal dangerous
    // statements (the engine's probe vocabulary can't express them — its
    // DML probes are deliberately WHERE-qualified). Each becomes one
    // engine `sql` call inside this single cloud request, so a panel run
    // stays one rate-limit unit. Same trust posture as `sql`: arbitrary
    // strings are fine, nothing executes.
    guardrail_sqls: z
      .array(z.string().min(1).max(10_000))
      .min(1)
      .max(MAX_GUARDRAIL_PROBES)
      .optional(),
  })
  .refine((b) => (b.probes === undefined) !== (b.sql === undefined), {
    message: "exactly one of probes | sql",
  })
  .refine((b) => b.guardrail_sqls === undefined || b.probes !== undefined, {
    message: "guardrail_sqls requires probes",
  });

// 503 details the client may see. dryRunPolicy's other details carry
// raw spawner/Fly error text — operationally useful in logs, but an
// internal-infrastructure leak in a response body. Anything not in
// this set is logged server-side and collapsed to "engine_unavailable".
const SAFE_UNAVAILABLE_DETAILS = new Set([
  "credential_unavailable",
  "invalid stored policy",
  "policy delivery failed after spawn",
  "engine image does not support dry-run yet",
  "engine timed out",
  "malformed dry-run response",
  "policy changed mid-run",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;

  // Per (customer, connection): each run can spawn or wake a Fly
  // machine — this is a cost/abuse cap. Keyed on the CUSTOMER too so a
  // tenant probing a foreign connection id burns their own budget, not
  // the owner's (review finding: the bare path param is unauthenticated
  // at this point).
  const limited = checkRateLimit(dryRunKey(customer.id, id), DRY_RUN_RATE_LIMIT);
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
  // closed on malformed stored policy. Credentials resolve concurrently
  // (independent per credential; a cache miss is a KMS roundtrip, and
  // serial resolves would stack on top of a possible cold spawn).
  const ctx = getMcpProxyContext();
  const decrypts = await Promise.all(
    databases.map((cdb) =>
      ctx.resolver.resolve({
        connectionDatabase: cdb,
        region: conn.region,
        customerId: conn.customerId,
      }),
    ),
  );
  const spawnDatabases = [];
  for (let i = 0; i < databases.length; i++) {
    const cdb = databases[i]!;
    const decrypt = decrypts[i]!;
    if (!decrypt.ok) {
      return Response.json(
        { error: "engine_unavailable", detail: "credential_unavailable" },
        { status: 503 },
      );
    }
    let tableAccess;
    let tenantScope;
    let guardrails;
    try {
      tableAccess = parsePolicyOrThrow(cdb.tableAccess);
      tenantScope = parseTenantScopeOrThrow(cdb.tenantScope);
      guardrails = parseGuardrailsOrThrow(cdb.guardrails);
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
      guardrails,
    });
  }

  // One engine call per request: the probe matrix (or custom statement)
  // first, then each guardrail statement as its own single-statement
  // `sql` request. The router pays acquire + push once for the sequence
  // and returns the verdicts concatenated in this order.
  const base = {
    database: parsed.data.database,
    tenant_context: { value: PROBE_TENANT_VALUE },
  };
  const requests: DryRunRequest[] = [
    {
      ...base,
      ...(parsed.data.probes ? { probes: parsed.data.probes } : {}),
      ...(parsed.data.sql ? { sql: parsed.data.sql } : {}),
    },
    ...(parsed.data.guardrail_sqls ?? []).map((sql) => ({ ...base, sql })),
  ];

  // Re-read of the policy entries right before the router's push. The
  // snapshot above can be a minute old by push time (cold spawn), and a
  // save committed in that window must not be overwritten on the live
  // engine by our older view. No decryption — push entries carry no DSN.
  const freshEntries = async (): Promise<DatabaseEntry[]> => {
    const fresh = await getConnectionWithDatabasesAndCredentials(customer, id);
    if (!fresh) throw new Error("connection disappeared during dry-run");
    return fresh.databases.map((cdb) => ({
      name: cdb.name,
      connectionDatabaseId: cdb.id,
      tableAccess: parsePolicyOrThrow(cdb.tableAccess),
      tenantScope: parseTenantScopeOrThrow(cdb.tenantScope),
      guardrails: parseGuardrailsOrThrow(cdb.guardrails),
    }));
  };

  const outcome = await ctx.dryRun(
    {
      connectionId: conn.id,
      region: conn.region,
      databases: spawnDatabases,
    },
    requests,
    freshEntries,
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
  // Spawner/Fly internals stay in the logs; the client gets a stable
  // detail vocabulary.
  const safeDetail =
    outcome.detail && SAFE_UNAVAILABLE_DETAILS.has(outcome.detail)
      ? outcome.detail
      : undefined;
  if (!safeDetail && outcome.detail) {
    console.error("[dry-run] engine_unavailable:", outcome.detail);
  }
  return Response.json(
    { error: "engine_unavailable", detail: safeDetail },
    { status: 503 },
  );
}
