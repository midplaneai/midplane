// GET /api/projects/:id/connect-status — the Connect pane's live-confirmation
// poll (support-channels-onboarding Day 2). Returns the phase the pane
// renders: waiting → connected (or connected_no_databases) → first_query with
// its decision → active (the live "N queries · last query …" steady-state).
// See lib/connect-status.ts for the state machine.
//
// Auth: session via currentCustomer; ownership-checked against
// projects.customer_id with the usual 404-on-foreign-row leakage shape.
// Deliberately NO manager gate — the Connect pane is a member surface
// (members connect their own agents) and the payload carries no secrets:
// a phase enum, grant/query counts, a first-query decision, and a
// last-query timestamp.
//
// Cache: no-store. The route exists to deliver fresher-than-page data;
// an HTTP cache here would defeat the purpose.

import { getConnectStatus, serializeConnectStatus } from "@/lib/connect-status";
import { currentCustomer } from "@/lib/customer";
import {
  checkRateLimit,
  CONNECT_STATUS_RATE_LIMIT,
  connectStatusKey,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  // Per-customer budget — this is a polled endpoint whose read fans out into
  // several DB queries, so an abusive poller (arbitrary project ids included)
  // gets bounded here. Keyed on the session's customer, never the path param.
  const limited = checkRateLimit(
    connectStatusKey(customer.id),
    CONNECT_STATUS_RATE_LIMIT,
  );
  if (!limited.ok) {
    return Response.json(
      { error: "too many requests" },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterS) },
      },
    );
  }
  const { id } = await params;
  const status = await getConnectStatus(customer, id);
  if (!status) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(serializeConnectStatus(status), {
    headers: { "cache-control": "no-store" },
  });
}
