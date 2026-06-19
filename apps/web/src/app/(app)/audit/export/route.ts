// GET /audit/export — download the audit log as CSV (default) or JSON,
// honoring the SAME filters the /audit page applies: status, tenant,
// database, agent, token, search, and the time window (clamped to the
// plan's retention). One row per logical query/event, capped at
// EXPORT_MAX rows; the X-Audit-Truncated header flags when the cap hit.
//
// Auth: session via currentCustomer (401 when not signed in),
// region-pinned + RLS-scoped through listAuditQueries — a customer can
// only ever pull their own rows.

import { eventSummary } from "@/components/audit/status-badge";
import {
  auditWindowSince,
  listAuditQueries,
  parseAuditWindow,
  resolveAuditWindow,
  QUERY_STATUSES,
  type QueryStatus,
} from "@/lib/audit";
import {
  recordsToCsv,
  recordsToJson,
  toExportRecords,
} from "@/lib/audit-export";
import { currentCustomer } from "@/lib/customer";
import { resolvePlan } from "@/lib/plan";

export const dynamic = "force-dynamic";

// Bound the pull. A window-clamped export over one customer is small in
// practice; this is the runaway guard, surfaced via X-Audit-Truncated.
const EXPORT_MAX = 5000;

export async function GET(req: Request) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { caps } = await resolvePlan();
  const sp = new URL(req.url).searchParams;

  const statuses = parseStatuses(sp.get("status"));
  const tenantId = sp.get("tenant_id")?.trim() || undefined;
  const database = sp.get("database")?.trim() || undefined;
  const agentName = sp.get("agent")?.trim() || undefined;
  const tokenId = sp.get("token")?.trim() || undefined;
  const projectId = sp.get("project")?.trim() || undefined;
  const search = sp.get("q")?.trim() || undefined;
  const window = resolveAuditWindow(
    parseAuditWindow(sp.get("window") ?? undefined),
    caps.auditRetentionDays,
  );
  // Same bucket-aligned lower bound the /audit page uses, so an export matches
  // exactly what the table showed.
  const windowSince = auditWindowSince(window, new Date());
  const format = sp.get("format") === "json" ? "json" : "csv";

  const { rows, nextCursor } = await listAuditQueries(customer.id, {
    region: customer.region,
    statuses,
    tenantId,
    database,
    agentName,
    tokenId,
    projectId,
    search,
    windowSince,
    retentionDays: caps.auditRetentionDays,
    pageSize: EXPORT_MAX,
  });

  const records = toExportRecords(rows, (r) =>
    eventSummary(r.status, r.policyPayload),
  );
  const body = format === "json" ? recordsToJson(records) : recordsToCsv(records);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename = `audit-${window.key}-${stamp}.${format}`;
  return new Response(body, {
    headers: {
      "content-type":
        format === "json"
          ? "application/json; charset=utf-8"
          : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-audit-truncated": nextCursor ? "true" : "false",
    },
  });
}

function parseStatuses(raw: string | null): readonly QueryStatus[] {
  if (!raw) return [];
  const valid = new Set<string>(QUERY_STATUSES);
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is QueryStatus => valid.has(s));
}
