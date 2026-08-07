// POST /api/engine/approvals/:projectId/status — read-only approval status.
//
// Backs the engine's `check_approval` tool. Called BY an engine container, same
// per-project HMAC bearer as the gate itself.
//
// Two properties distinguish this from the gate route next to it:
//
//   • It NEVER claims a grant. An agent asking "any news?" has not committed to
//     executing; consuming its single-use approval on a poll would burn it.
//   • It answers in one round trip. No hold, no long-poll — the whole point is a
//     cheap check that does not cost 20 seconds of a control-plane connection.
//
// It also never returns the statement or its results. The agent already has its
// own SQL, and the control plane has never seen a result row — the engine
// executes and returns rows straight to the agent. Echoing either back would
// turn an id into a read surface.

import { eq } from "drizzle-orm";

import { getDb, projects } from "@midplane-cloud/db";
import { bearerFrom, verifyApprovalToken } from "@midplane-cloud/router";

import { checkApprovalStatus } from "@/lib/approvals";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await params;

  const master = process.env.MIDPLANE_APPROVAL_SECRET;
  if (!master) {
    return Response.json({ error: "approvals_not_configured" }, { status: 503 });
  }
  if (
    !verifyApprovalToken(master, projectId, bearerFrom(req.headers.get("authorization")))
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { approval_id?: unknown; mcp_token_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const approvalId =
    typeof body.approval_id === "string" && body.approval_id ? body.approval_id : null;
  if (!approvalId) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const project = await findProject(projectId);
  if (!project) return Response.json({ error: "not_found" }, { status: 404 });

  const status = await checkApprovalStatus({
    region: project.region,
    projectId,
    approvalId,
    // Scoping is by TOKEN, not just project: the bearer proves which project
    // the engine speaks for, not which agent is asking inside it.
    mcpTokenId:
      typeof body.mcp_token_id === "string" && body.mcp_token_id
        ? body.mcp_token_id
        : null,
  });

  return Response.json(toWire(status));
}

function toWire(
  s: Awaited<ReturnType<typeof checkApprovalStatus>>,
): Record<string, unknown> {
  switch (s.status) {
    case "pending":
      return { status: "pending", expires_at: s.expiresAt };
    case "approved":
      return { status: "approved", by: s.by, note: s.note };
    case "denied":
      return { status: "denied", by: s.by, note: s.note };
    case "executed":
    case "expired":
    case "not_found":
      return { status: s.status };
  }
}

/** The project row lives in its customer's region, and we don't know the region
 *  until we've found it. A workspace is single-region by construction, so at
 *  most one of these hits; an unreachable region just isn't where it lives. */
async function findProject(projectId: string) {
  for (const region of ["eu", "us"] as const) {
    try {
      const rows = await getDb(region)
        .select({ id: projects.id, region: projects.region })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (rows[0]) return rows[0];
    } catch {
      continue;
    }
  }
  return null;
}
