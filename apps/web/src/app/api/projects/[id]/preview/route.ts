// POST /api/projects/:id/preview — masked preview (design D2 / eng-review E1).
//
// Runs a real, read-only SELECT through the engine's `query` tool against the
// spawned container and returns the AGENT'S-EYE (masked) rows — the only way to
// PROVE masking. The dry-run surface stops at the decision step by design and
// cannot execute, so it can't show a masked value; this one does.
//
// This EXECUTES against the customer database, so the blast radius is capped:
//   - owner/admin only (requireManagerRest, same gate as the scan route),
//   - per-(customer, project) rate limited (each run executes a query),
//   - read-only single SELECT validated before we spawn anything,
//   - rows handed back are capped (the engine still runs the full statement).
//
// Status mapping:
//   200 — { allowed: true, rows, ... }  (executed + masked)
//   200 — { allowed: false, policyRule, reason }  (engine denied — INCLUDING the
//         fail-closed column_masking reject; rendered as an explained state, not
//         an error, per design D2)
//   400 — invalid body / not a read-only SELECT
//   401 — not signed in   403 — not owner/admin
//   404 — foreign/unknown project or database
//   429 — rate limited
//   503 — engine unavailable (spawn/handshake failed, mask salt misconfigured)

import { z } from "zod";

import {
  parseColumnMasksOrThrow,
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
} from "@midplane-cloud/db";
import type { SpawnDatabase } from "@midplane-cloud/router";

import { createHmac } from "node:crypto";

import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { requireManagerRest } from "@/lib/org-auth";
import { isReadOnlySelect } from "@/lib/preview-sql";
import { getProjectWithDatabasesAndCredentials } from "@/lib/projects";
import {
  checkRateLimit,
  PREVIEW_RATE_LIMIT,
  previewKey,
} from "@/lib/rate-limit";

// Rows the engine still computes in full; this only bounds the payload that
// leaves the boundary (and the table the browser renders). Small on purpose —
// a preview is a proof, not a data export.
const MAX_PREVIEW_ROWS = 25;

// Stamped on every audit row the preview emits, so a console preview is legible
// in the audit log as exactly that — not a real agent query.
const PREVIEW_INTENT = "Masked preview run from the Midplane console";

const Body = z.object({
  database: z.string().min(1).max(64),
  sql: z.string().min(1).max(10_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  // Owner/admin only — this decrypts the DB credential and executes a query
  // against the customer's data. A member intentionally blocked from this
  // surface must not reach it by calling the route directly. Gate BEFORE any
  // credential resolution or spawn (same posture as the scan route).
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;

  const { id } = await params;

  // Per (customer, project): each run executes a real query and can spawn/wake
  // a machine. Keyed on the customer too so probing a foreign project id burns
  // the prober's own budget, not the owner's.
  const limited = checkRateLimit(
    previewKey(customer.id, id),
    PREVIEW_RATE_LIMIT,
  );
  if (!limited.ok) {
    return Response.json(
      { error: "too many preview runs — try again shortly" },
      { status: 429, headers: { "retry-after": String(limited.retryAfterS) } },
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

  // Read-only floor (defense in depth on top of the engine's read enforcement).
  const readOnly = isReadOnlySelect(parsed.data.sql);
  if (!readOnly.ok) {
    return Response.json({ error: readOnly.reason }, { status: 400 });
  }

  const result = await getProjectWithDatabasesAndCredentials(customer, id);
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const { project, databases } = result;
  if (!databases.some((d) => d.name === parsed.data.database)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Same spawn construction as the proxy (lib/proxy.ts): the container boots
  // with the FULL DB set, every DSN decrypted, every config parsed at the
  // boundary (fail closed on malformed stored policy). Unlike dry-run we MUST
  // carry columnMasks so the spawned engine has masking configured.
  const ctx = getMcpProxyContext();
  const decrypts = await Promise.all(
    databases.map((cdb) =>
      ctx.resolver.resolve({
        projectDatabase: cdb,
        region: project.region,
        customerId: project.customerId,
      }),
    ),
  );
  const spawnDatabases: SpawnDatabase[] = [];
  for (let i = 0; i < databases.length; i++) {
    const cdb = databases[i]!;
    const decrypt = decrypts[i]!;
    if (!decrypt.ok) {
      return Response.json(
        { error: "engine_unavailable", detail: "credential_unavailable" },
        { status: 503 },
      );
    }
    try {
      spawnDatabases.push({
        name: cdb.name,
        projectDatabaseId: cdb.id,
        dsn: decrypt.plaintext,
        tableAccess: parsePolicyOrThrow(cdb.tableAccess),
        tenantScope: parseTenantScopeOrThrow(cdb.tenantScope),
        guardrails: parseGuardrailsOrThrow(cdb.guardrails),
        columnMasks: parseColumnMasksOrThrow(cdb.columnMasks),
      });
    } catch (err) {
      console.error("[preview] invalid stored policy", err);
      return Response.json(
        { error: "engine_unavailable", detail: "invalid stored policy" },
        { status: 503 },
      );
    }
  }

  // Masking salt (W1), identical derivation to the proxy: a per-project secret
  // from the control-plane master, injected as MIDPLANE_MASK_SALT. Fail closed
  // — masks declared but no master configured means the engine would refuse to
  // boot, so refuse here with a clear unavailable rather than a cryptic spawn
  // failure. No masks ⇒ no salt needed.
  const anyMasked = spawnDatabases.some(
    (d) => d.columnMasks && Object.keys(d.columnMasks).length > 0,
  );
  let maskSalt: string | undefined;
  if (anyMasked) {
    const master = process.env.MIDPLANE_MASK_SALT_MASTER;
    if (!master) {
      console.error(
        `[preview] project ${project.id} has column_masks but MIDPLANE_MASK_SALT_MASTER is unset — refusing to spawn`,
      );
      return Response.json(
        { error: "engine_unavailable", detail: "masking misconfigured" },
        { status: 503 },
      );
    }
    maskSalt = createHmac("sha256", master).update(project.id).digest("hex");
  }

  const outcome = await ctx.preview(
    {
      projectId: project.id,
      region: project.region,
      databases: spawnDatabases,
      maskSalt,
    },
    {
      database: parsed.data.database,
      sql: parsed.data.sql,
      intent: PREVIEW_INTENT,
      rowLimit: MAX_PREVIEW_ROWS,
    },
  );

  if (!outcome.ok) {
    // Spawner/handshake internals stay in the logs; the client gets a stable
    // retryable signal.
    if (outcome.detail) console.error("[preview] engine_unavailable:", outcome.detail);
    return Response.json({ error: "engine_unavailable" }, { status: 503 });
  }

  if (outcome.kind === "rejected") {
    // A normal engine denial — INCLUDING the fail-closed column_masking reject.
    // 200, not an error status: the client renders this as an explained state
    // (the reason carries the "select the column directly" hint), not a 4xx.
    return Response.json({
      allowed: false,
      policyRule: outcome.policyRule,
      reason: outcome.reason,
      auditId: outcome.auditId,
    });
  }

  return Response.json({
    allowed: true,
    rows: outcome.rows,
    rowCount: outcome.rowCount,
    truncated: outcome.truncated,
    rowLimit: MAX_PREVIEW_ROWS,
    auditId: outcome.auditId,
  });
}
