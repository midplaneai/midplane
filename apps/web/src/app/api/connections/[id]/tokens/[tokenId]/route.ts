// DELETE /api/connections/:id/tokens/:tokenId — revoke a token.
//
// Idempotent: revoking an already-revoked OR expired token returns 200
// with the row, not an error. The lib's revokeToken does the no-op
// branch (status read first; only transition active → revoked rewrites
// timestamps). Forensic record (original revoked_at, revoked_reason)
// is preserved across retries.
//
// 404 — not 401/403 — when the connection OR the token is unknown OR
// owned by a different customer (same leakage-avoidance shape as the
// list/create route and the parent /api/connections/[id]).

import { getOrgContext } from "@/lib/org-context";
import { z } from "zod";

import { currentCustomer } from "@/lib/customer";
import { getPostHog } from "@/lib/posthog";
import { revokeToken } from "@/lib/tokens";

const Body = z
  .object({
    reason: z.string().min(1).max(64).optional(),
  })
  .optional();

const DEFAULT_REASON = "user_action";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; tokenId: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { userId } = await getOrgContext();
  if (!userId) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id, tokenId } = await params;

  // DELETE bodies are optional. If present we parse; if absent or
  // empty we treat the reason as the default. Both JSON and form-data
  // are accepted so the dashboard's Server Action and a curl client
  // share the same surface.
  let raw: unknown = {};
  const contentType = req.headers.get("content-type") ?? "";
  if (req.body) {
    if (contentType.includes("application/json")) {
      try {
        raw = await req.json();
      } catch {
        // Empty / unparseable body — treat as no overrides.
        raw = {};
      }
    } else if (contentType) {
      const form = await req.formData();
      raw = Object.fromEntries(form.entries());
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const reason = parsed.data?.reason ?? DEFAULT_REASON;

  const result = await revokeToken(customer, id, tokenId, {
    reason,
    actorUserId: userId,
  });
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  getPostHog()?.capture({
    distinctId: userId,
    event: "token_revoked",
    properties: {
      token_id: result.id,
      connection_id: id,
      region: customer.region,
      reason,
      source: "api",
    },
  });

  return Response.json({ id: result.id });
}
