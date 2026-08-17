// POST /api/projects/test-dsn — pre-create DSN reachability probe
// for the new-project form. Unlike the per-project sibling
// (/api/projects/:id/databases/test) there is no parent id yet, so
// the gate is the session alone — which is exactly why this
// surface is rate-limited and SSRF-guarded: a signed-up account must
// not get a free internal-network reachability oracle.
//
// Static route segment beats the [id] sibling, so "test-dsn" can never
// be captured as a project id.

import { getOrgContext } from "@/lib/org-context";
import { z } from "zod";

import { describeDsnProblem, normalizeDsn } from "@/lib/dsn-format";
import { currentCustomer } from "@/lib/customer";
import { pingDsnGuarded } from "@/lib/ping-guard";
import { analyticsGroups } from "@/lib/analytics";
import { getPostHog } from "@/lib/posthog";
import {
  checkRateLimit,
  PING_TEST_RATE_LIMIT,
  pingTestKey,
} from "@/lib/rate-limit";

// Shape only. The DSN's own validity is checked with describeDsnProblem below
// so the 400 can carry the sentence the form shows the user — a zod refine
// buries its message in `issues`, and the client was rendering the envelope
// ("invalid body") instead.
const TestBody = z.object({ dsn: z.string() });

export async function POST(req: Request) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { userId } = await getOrgContext();

  const limited = checkRateLimit(pingTestKey(customer.id), PING_TEST_RATE_LIMIT);
  if (!limited.ok) {
    return Response.json(
      { error: "too many tests — try again shortly" },
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
  const parsed = TestBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const dsn = normalizeDsn(parsed.data.dsn);
  const problem = describeDsnProblem(dsn);
  if (problem) {
    // Renderable sentence + remedy, in the same `{error, hint}` shape the
    // probe result uses — the button shows one block either way.
    return Response.json(
      { ok: false, error: problem.message, hint: problem.hint },
      { status: 400 },
    );
  }

  const result = await pingDsnGuarded(dsn);

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "database_test_run",
      properties: {
        region: customer.region,
        success: result.ok,
        source: "new_project_form",
      },
      groups: analyticsGroups({ customerId: customer.id }),
    });
  }

  return Response.json(result);
}
