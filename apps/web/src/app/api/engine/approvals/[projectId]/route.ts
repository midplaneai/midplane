// POST /api/engine/approvals/:projectId — the write-approval gate.
//
// Called by the ENGINE, not by a browser. See docs/designs/write-approvals-mlp.md.
//
// Auth is a per-project HMAC bearer (packages/router/src/approval-token.ts), not
// a shared secret: the token IS the project binding, so an engine cannot file
// requests against — or collect grants belonging to — a project other than its
// own. The `:projectId` in the path and the token must agree or this 401s.
//
// This handler HOLDS the connection for up to ~20s waiting for a human. That is
// deliberate and it is the reason the design needs no MCP progress
// notifications: 20s here sits under the engine's 25s deadline, which sits under
// the MCP client's ~60s timeout. A fast approval returns inside the agent's
// first tool call; a slow one degrades to a ticket the agent redeems by
// re-running the statement.
//
// Failure posture: every error path returns a non-2xx, and the engine turns any
// non-2xx into ApprovalUnavailableError — a retryable outage, never a denial.
// So there is no shape of failure here that can manufacture a refusal nobody
// made, and none that can let a write through either.

import { and, eq } from "drizzle-orm";

import { getDb, projectDatabases, projects } from "@midplane-cloud/db";
import { parseApprovalsOrThrow } from "@midplane-cloud/db/policy";
import { bearerFrom, verifyApprovalToken } from "@midplane-cloud/router";

import { resolveApproval, ApprovalRaceError } from "@/lib/approvals";
import { notifyApprovalRequested } from "@/lib/approval-notify";

export const dynamic = "force-dynamic";
// The hold can outlast the default serverless budget; give it room to answer
// `pending` on its own terms rather than being cut off mid-wait.
export const maxDuration = 60;

interface GateBody {
  query_id?: unknown;
  database?: unknown;
  sql?: unknown;
  intent?: unknown;
  statement_type?: unknown;
  tables_touched?: unknown;
  tenant_id?: unknown;
  agent_name?: unknown;
  agent_version?: unknown;
  mcp_token_id?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await params;

  const master = process.env.MIDPLANE_APPROVAL_SECRET;
  if (!master) {
    // Approvals are not provisioned on this deployment. 503 rather than 401:
    // the engine should read this as "try again", not "you are not allowed",
    // because an operator fixing the env is exactly what makes it work.
    return Response.json({ error: "approvals_not_configured" }, { status: 503 });
  }

  if (!verifyApprovalToken(master, projectId, bearerFrom(req.headers.get("authorization")))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: GateBody;
  try {
    body = (await req.json()) as GateBody;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const sql = str(body.sql);
  const databaseName = str(body.database);
  const queryId = str(body.query_id);
  if (!sql || !databaseName || !queryId) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // The project row carries the region AND the customer. Both come from OUR
  // record keyed by the verified project id — never from the request body, so a
  // compromised engine cannot file a request against another customer.
  const project = await findProject(projectId);
  if (!project) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const db = await findDatabase(project.region, projectId, databaseName);
  if (!db) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Read expiry from OUR stored config rather than trusting the engine. The
  // engine is never told the request's lifetime (it has no use for it), so it
  // could not supply this even if we wanted it to.
  let expiresAfterSeconds: number;
  try {
    expiresAfterSeconds = parseApprovalsOrThrow(db.approvals).expires_after_seconds;
  } catch {
    // Unparseable stored config is a control-plane fault. Fail closed as an
    // outage so the engine refuses the write and retries later.
    return Response.json({ error: "invalid_approvals_config" }, { status: 500 });
  }

  const input = {
    customerId: project.customerId,
    projectId,
    projectDatabaseId: db.id,
    region: project.region,
    queryId,
    sql,
    intent: str(body.intent) ?? "",
    statementType: str(body.statement_type) ?? "UNKNOWN",
    tablesTouched: Array.isArray(body.tables_touched)
      ? body.tables_touched.filter((t): t is string => typeof t === "string")
      : [],
    agentName: str(body.agent_name),
    mcpTokenId: str(body.mcp_token_id),
    expiresAfterSeconds,
  };

  let answer;
  try {
    answer = await resolveApproval(input, {
      onCreated: (approval) => {
        // Fire-and-forget, off the hold path. A Resend outage must never turn
        // into held writes failing to be held — the in-app queue is
        // authoritative whether or not any email sends.
        void notifyApprovalRequested({
          approvalId: approval.id,
          customerId: project.customerId,
          projectId,
          region: project.region,
          database: databaseName,
          agentName: input.agentName,
          expiresAt: approval.expiresAt,
        });
      },
    });
  } catch (err) {
    if (err instanceof ApprovalRaceError) {
      // Settled underneath us. 409 so the engine retries and picks up the real
      // decision instead of us guessing one.
      return Response.json({ error: "conflict" }, { status: 409 });
    }
    console.error("[approvals] gate failed:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  return Response.json(toWire(answer));
}

/** Where a human goes to act on this request.
 *
 *  Built from MIDPLANE_APP_ORIGIN, NOT from `req.url`. The inbound request came
 *  from the ENGINE, so its host is whatever address the container was told to
 *  dial — `host.docker.internal` in local dev, an internal listen host behind
 *  Fly. Echoing that back would hand the agent (and the developer reading its
 *  output) a link that is at best odd and at worst unreachable. */
function reviewUrl(approvalId: string): string {
  const base =
    process.env.MIDPLANE_APP_ORIGIN?.replace(/\/$/, "") ?? "https://app.midplane.ai";
  return `${base}/approvals/${approvalId}`;
}

/** Wire shape the engine's parseOutcome() understands. */
function toWire(
  answer: Awaited<ReturnType<typeof resolveApproval>>,
): Record<string, unknown> {
  switch (answer.status) {
    case "approved":
    case "denied":
      return { status: answer.status, by: answer.by, note: answer.note };
    case "expired":
      return { status: "expired" };
    case "pending":
      return {
        status: "pending",
        approval_id: answer.approvalId,
        expires_at: answer.expiresAt,
        review_url: reviewUrl(answer.approvalId),
      };
  }
}

async function findProject(projectId: string) {
  // The project row lives in its customer's region, and we don't know the
  // region until we've found it — so try each. A workspace is single-region by
  // construction (projects carries a composite FK onto customers(id, region)),
  // so at most one of these hits.
  for (const region of ["eu", "us"] as const) {
    try {
      const rows = await getDb(region)
        .select({
          id: projects.id,
          customerId: projects.customerId,
          region: projects.region,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (rows[0]) return rows[0];
    } catch {
      // A region this deployment cannot reach (DATABASE_URL_US unset in a
      // single-region install) is not an error — it just isn't where the
      // project lives.
      continue;
    }
  }
  return null;
}

async function findDatabase(
  region: "eu" | "us",
  projectId: string,
  name: string,
) {
  const rows = await getDb(region)
    .select({ id: projectDatabases.id, approvals: projectDatabases.approvals })
    .from(projectDatabases)
    .where(
      and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.name, name)),
    )
    .limit(1);
  return rows[0] ?? null;
}
