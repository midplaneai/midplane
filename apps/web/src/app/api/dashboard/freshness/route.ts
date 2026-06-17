// GET /api/dashboard/freshness — slim per-customer snapshot of the
// freshness signals the dashboard polls every 60s. Returns the
// connection-level cursor (lastIndexedAt + lastErrorAt) AND per-DB
// lastQueryAt aggregated from audit_events_index, but no policy /
// ciphertext / mcp_token. The client hook merges this into local
// state and re-renders only the freshness dots + meta lines; rename
// / menu / sheet state are unaffected.
//
// Auth: session via currentCustomer. 401 when not signed in;
// scoped to the customer's own data, no leakage shape needed.
//
// Cache: no-store. The route exists to deliver fresher-than-page-cache
// data; an HTTP cache here would defeat the purpose.

import { getDashboardFreshness } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { resolvePlan } from "@/lib/plan";

export const dynamic = "force-dynamic";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { caps } = await resolvePlan();
  const snapshot = await getDashboardFreshness(customer, caps.auditRetentionDays);
  return Response.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
