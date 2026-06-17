// PATCH /api/connections/:id   — rotate DSN (CRITICAL: cache invalidation)
// DELETE /api/connections/:id  — delete connection + stop container
//
// Security posture for both verbs:
//  - 404 (not 401/403) when the row exists but belongs to another customer.
//    Mirrors deleteConnection's leakage shape: the API never confirms or
//    denies the existence of someone else's connection.
//  - The Clerk session is the ONLY authentication path. There is no
//    service-token shortcut, no "internal" header bypass.
//
// Rotation is the high-stakes verb here. A customer paste-rotates because
// their old DSN leaked or they migrated DBs; if either DecryptCache or the
// running ContainerRegistry entry survives the swap, the OSS container keeps
// serving the OLD DSN until the 30-min idle timer fires. rotateConnection
// in @/lib/connections is the single place that orchestrates DB write +
// both cache invalidations; this route is just the HTTP shell around it.
//
// PR2 of mcp_url_auth_security: rotation no longer returns a token —
// the agent-facing URL is unchanged because tokens are independent of
// DSN rotation. Response carries only { id } (the connection id).
// Token lifecycle (list / create / revoke) lives on PR3's surface.

import { getOrgContext } from "@/lib/org-context";
import { z } from "zod";

import {
  deleteConnection,
  isValidDsn,
  rotateConnection,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { getPostHog } from "@/lib/posthog";

const RotateBody = z.object({
  dsn: z.string().refine(isValidDsn, {
    message: "must be a postgres:// or postgresql:// URL",
  }),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { userId } = await getOrgContext();
  const { id } = await params;

  let raw: unknown;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    raw = await req.json();
  } else {
    const form = await req.formData();
    raw = Object.fromEntries(form.entries());
  }
  const parsed = RotateBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const ctx = getMcpProxyContext();
  const rotated = await rotateConnection(customer, id, parsed.data.dsn, ctx);
  if (!rotated) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "connection_rotated",
      properties: {
        connection_id: rotated.id,
        region: customer.region,
        source: "api",
      },
    });
  }

  return Response.json({ id: rotated.id });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { userId } = await getOrgContext();
  const { id } = await params;
  const deleted = await deleteConnection(customer, id);
  if (!deleted) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const ctx = getMcpProxyContext();
  await ctx.registry.invalidate(deleted.id).catch((err) => {
    console.error("[DELETE /api/connections] registry.invalidate failed", err);
  });

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "connection_deleted",
      properties: {
        connection_id: deleted.id,
        region: customer.region,
        source: "api",
      },
    });
  }

  return Response.json({ ok: true });
}
