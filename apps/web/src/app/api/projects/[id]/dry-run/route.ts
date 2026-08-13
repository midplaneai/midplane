// POST /api/projects/:id/dry-run — one policy verdict for one statement,
// behind the pane's "Try a statement". Body: { database, sql }. The verdict
// is computed by the OSS engine via packages/router's dryRunPolicy
// (acquire → pushPolicy → /admin/dry-run); this route owns auth,
// ownership, rate limiting, request validation, and building the same
// SpawnOptions the MCP proxy builds (every DB decrypted — the engine
// container boots with the full set).
//
// The engine also accepts a structured `probes` matrix; the cloud no longer
// sends one. Reconciling a matrix meant keeping a second, cloud-side model of
// table-access semantics, and a disagreement between the two never said which
// one was wrong.
//
// Status mapping:
//   200 — verdicts (the engine answered)
//   400 — engine rejected the request (its error body verbatim, same
//         convention as policy hot-reload errors) or invalid body
//   404 — foreign/unknown project or database (standard leakage shape)
//   429 — per-project rate limit (each run can spawn/wake a machine)
//   503 — engine unavailable (spawn failed, timeout, image predates
//         dry-run, INDEXER_TOKEN unset) — retryable
//
// Nothing executes: the statement stops at the decision step. Tenant
// context is synthetic (nothing dials the customer DB), so no real tenant
// value is ever needed here.

import { createHmac } from "node:crypto";

import { z } from "zod";

import {
  parseColumnMasksOrThrow,
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
  type DatabaseEntry,
} from "@midplane-cloud/db";
import type { DryRunRequest } from "@midplane-cloud/router";

import { getProjectWithDatabasesAndCredentials } from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import {
  checkRateLimit,
  DRY_RUN_RATE_LIMIT,
  dryRunKey,
} from "@/lib/rate-limit";

/** Synthetic tenant bound by the engine during dry-run. Nothing executes, so
 *  no real tenant value is ever needed. */
const PROBE_TENANT_VALUE = "__midplane_probe__";

const Body = z.object({
  database: z.string().min(1).max(64),
  // Arbitrary strings are fine: nothing executes, and an unparseable statement
  // comes back as a parse_error verdict rather than an error.
  sql: z.string().min(1).max(10_000),
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

  // Per (customer, project): each run can spawn or wake a Fly
  // machine — this is a cost/abuse cap. Keyed on the CUSTOMER too so a
  // tenant probing a foreign project id burns their own budget, not
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

  const result = await getProjectWithDatabasesAndCredentials(customer, id);
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const { project: conn, databases } = result;
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
        projectDatabase: cdb,
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
      projectDatabaseId: cdb.id,
      dsn: decrypt.plaintext,
      tableAccess,
      tenantScope,
      guardrails,
      // Carry masks even though dry-run only tests ACCESS decisions (nothing
      // executes, so masks don't change a verdict). The container is shared via
      // the registry — booting it mask-less would leave a mask-less container
      // warm for the masked proxy/preview paths to reuse, silently dropping
      // masking (a bypass). Spawning with the same masks keeps the pool honest.
      columnMasks: parseColumnMasksOrThrow(cdb.columnMasks),
    });
  }

  // Masking salt (W1): same derivation as the proxy/preview so the dry-run's
  // spawn fingerprint matches theirs. Fail closed if masks exist without a
  // configured master — booting masked-without-salt would crash the engine.
  const anyMasked = spawnDatabases.some(
    (d) => d.columnMasks && Object.keys(d.columnMasks).length > 0,
  );
  let maskSalt: string | undefined;
  if (anyMasked) {
    const master = process.env.MIDPLANE_MASK_SALT_MASTER;
    if (!master) {
      console.error(
        `[dry-run] project ${conn.id} has column_masks but MIDPLANE_MASK_SALT_MASTER is unset — refusing to spawn`,
      );
      return Response.json(
        { error: "engine_unavailable", detail: "masking misconfigured" },
        { status: 503 },
      );
    }
    maskSalt = createHmac("sha256", master).update(conn.id).digest("hex");
  }

  // One statement, one engine call. The router pays acquire + push for it.
  const requests: DryRunRequest[] = [
    {
      database: parsed.data.database,
      tenant_context: { value: PROBE_TENANT_VALUE },
      sql: parsed.data.sql,
    },
  ];

  // Re-read of the policy entries right before the router's push. The
  // snapshot above can be a minute old by push time (cold spawn), and a
  // save committed in that window must not be overwritten on the live
  // engine by our older view. No decryption — push entries carry no DSN.
  const freshEntries = async (): Promise<DatabaseEntry[]> => {
    const fresh = await getProjectWithDatabasesAndCredentials(customer, id);
    if (!fresh) throw new Error("project disappeared during dry-run");
    return fresh.databases.map((cdb) => ({
      name: cdb.name,
      projectDatabaseId: cdb.id,
      tableAccess: parsePolicyOrThrow(cdb.tableAccess),
      tenantScope: parseTenantScopeOrThrow(cdb.tenantScope),
      guardrails: parseGuardrailsOrThrow(cdb.guardrails),
    }));
  };

  const outcome = await ctx.dryRun(
    {
      projectId: conn.id,
      region: conn.region,
      databases: spawnDatabases,
      maskSalt,
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
