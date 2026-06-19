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

import { isValidDsn } from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { pingDsnGuarded } from "@/lib/ping-guard";
import { getPostHog } from "@/lib/posthog";
import {
  checkRateLimit,
  PING_TEST_RATE_LIMIT,
  pingTestKey,
} from "@/lib/rate-limit";

const TestBody = z.object({
  dsn: z.string().refine(isValidDsn, {
    message: "must be a postgres:// or postgresql:// URL",
  }),
});

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

  const result = await pingDsnGuarded(parsed.data.dsn);

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "database_test_run",
      properties: {
        region: customer.region,
        success: result.ok,
        source: "new_project_form",
      },
    });
  }

  return Response.json(result);
}
