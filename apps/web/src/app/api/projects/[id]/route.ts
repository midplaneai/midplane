// PATCH /api/projects/:id   — rotate DSN (CRITICAL: cache invalidation)
// DELETE /api/projects/:id  — delete project + stop container
//
// Security posture for both verbs:
//  - 404 (not 401/403) when the row exists but belongs to another customer.
//    Mirrors deleteProject's leakage shape: the API never confirms or
//    denies the existence of someone else's project.
//  - The session is the ONLY authentication path. There is no
//    service-token shortcut, no "internal" header bypass.
//
// Rotation is the high-stakes verb here. A customer paste-rotates because
// their old DSN leaked or they migrated DBs; if either DecryptCache or the
// running ContainerRegistry entry survives the swap, the OSS container keeps
// serving the OLD DSN until the 30-min idle timer fires. rotateProject
// in @/lib/projects is the single place that orchestrates DB write +
// both cache invalidations; this route is just the HTTP shell around it.
//
// PR2 of mcp_url_auth_security: rotation no longer returns a token —
// the agent-facing URL is unchanged because tokens are independent of
// DSN rotation. Response carries only { id } (the project id).
// Token lifecycle (list / create / revoke) lives on PR3's surface.

import { z } from "zod";

import {
  deleteProject,
  getProjectWithFirstDatabase,
  isValidDsn,
  rotateProject,
} from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { requireManagerRest } from "@/lib/org-auth";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { analyticsGroups } from "@/lib/analytics";
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
  // Rotating a project's DSN is owner/admin only — it can repoint the project
  // at another database, so it's a manager capability, not an operator one.
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;
  const { userId } = gate;
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

  // This route has no db param — it targets the project's database (the
  // only one for a single-DB project). Resolve its name so rotation doesn't
  // assume a fixed "main" alias, which no longer holds now that the first DB
  // is named from the DSN. A 404 here is the same leakage shape as below.
  const target = await getProjectWithFirstDatabase(customer, id);
  if (!target) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ctx = getMcpProxyContext();
  const rotated = await rotateProject(
    customer,
    id,
    parsed.data.dsn,
    ctx,
    target.database.name,
  );
  if (!rotated) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "project_rotated",
      properties: {
        project_id: rotated.id,
        region: customer.region,
        source: "api",
      },
      groups: analyticsGroups({
        customerId: customer.id,
        projectId: rotated.id,
      }),
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
  // Deleting a project is owner/admin only.
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;
  const { userId } = gate;
  const { id } = await params;
  const deleted = await deleteProject(customer, id);
  if (!deleted) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const ctx = getMcpProxyContext();
  await ctx.registry.invalidate(deleted.id).catch((err) => {
    console.error("[DELETE /api/projects] registry.invalidate failed", err);
  });

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "project_deleted",
      properties: {
        project_id: deleted.id,
        region: customer.region,
        source: "api",
      },
      groups: analyticsGroups({
        customerId: customer.id,
        projectId: deleted.id,
      }),
    });
  }

  return Response.json({ ok: true });
}
