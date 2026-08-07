// Reads and decisions for the /approvals queue.
//
// Cross-project by design: an approver thinks in terms of "what is waiting on
// me", not "which project was that in". That costs nothing to query — a
// workspace is single-region by construction (projects carries a composite
// (customer_id, region) FK onto customers), so one indexed read on
// (customer_id, region, status, created_at) covers the whole queue.

import { and, desc, eq, gt, lte, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  getDb,
  projectDatabases,
  projects,
  auditEventsIndex,
  mcpTokens,
  writeApprovals,
  type Region,
  type WriteApprovalStatus,
} from "@midplane-cloud/db";
import { user } from "@midplane-cloud/db/auth-schema";

// Two different people can appear on one approval — the person the agent acts
// for, and the person who decided it — so the user table joins twice under
// distinct aliases.
const requester = alias(user, "requester");

export interface QueueRow {
  id: string;
  projectId: string;
  projectName: string | null;
  database: string;
  sqlText: string;
  intent: string;
  statementType: string;
  tablesTouched: string[];
  agentName: string | null;
  status: string;
  decidedByUserId: string | null;
  /** Who decided it, as a human would recognise them: display name, else email,
   *  else null. The raw user id is useless on a screen whose whole job is
   *  accountability — "approved by 01J8..." tells nobody anything. Null when the
   *  account has since been deleted, which reads as "someone who is gone" rather
   *  than inventing a name. */
  decidedByName: string | null;
  /** The human the agent is acting for, resolved through the MCP token that
   *  opened the session. For an interactive OAuth agent this is whoever
   *  authorized it; for a machine token it is whoever minted it — a real
   *  distinction, since nobody is watching an unattended token. Null when the
   *  caller presented no token, or the account is gone. */
  requestedByName: string | null;
  /** "oauth" (a person drove this) vs "url" (a machine token, unattended). */
  agentKind: string | null;
  /** What the approved statement actually DID, joined through the attempt that
   *  consumed the grant. Null until it runs — an approval and its execution are
   *  separate events, and there is a real window between them. Closing the loop
   *  matters on an accountability surface: "approved by X" without "and it
   *  changed 1,284 rows" is half a record. */
  executedAuditId: string | null;
  executedRowsAffected: number | null;
  executedAt: Date | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/** Everything still waiting in this workspace, newest first. */
export async function listPendingApprovals(
  region: Region,
  customerId: string,
  limit = 100,
): Promise<QueueRow[]> {
  return selectRows(region, customerId, "pending", limit);
}

/** Recently settled requests — the "Decided" tab. */
export async function listDecidedApprovals(
  region: Region,
  customerId: string,
  limit = 50,
): Promise<QueueRow[]> {
  const db = getDb(region);
  const rows = await db
    .select(SELECTION)
    .from(writeApprovals)
    .leftJoin(projects, eq(writeApprovals.projectId, projects.id))
    .leftJoin(
      projectDatabases,
      eq(writeApprovals.projectDatabaseId, projectDatabases.id),
    )
    .leftJoin(user, eq(writeApprovals.decidedByUserId, user.id))
    // LEFT joins throughout: a revoked token or deleted account must not drop
    // the approval from an accountability surface.
    .leftJoin(mcpTokens, eq(writeApprovals.mcpTokenId, mcpTokens.id))
    .leftJoin(requester, eq(mcpTokens.createdByUserId, requester.id))
    // The EXECUTED row for the attempt that consumed this grant. Joined on
    // claimed_query_id, NOT query_id: the held attempt never ran.
    .leftJoin(
      auditEventsIndex,
      and(
        eq(auditEventsIndex.queryId, writeApprovals.claimedQueryId),
        eq(auditEventsIndex.eventType, "EXECUTED"),
      ),
    )
    .where(
      and(
        eq(writeApprovals.customerId, customerId),
        eq(writeApprovals.region, region),
        // Filter in SQL, not after. Filtering the page in JS applies LIMIT to
        // rows of ALL statuses first, so a workspace with 50 newer pending
        // requests would show an empty Decided tab while decided rows sat just
        // past the cutoff.
        ne(writeApprovals.status, "pending"),
      ),
    )
    .orderBy(desc(writeApprovals.createdAt))
    .limit(limit);
  return rows.map(shape);
}

export async function getApproval(
  region: Region,
  customerId: string,
  id: string,
): Promise<QueueRow | null> {
  const db = getDb(region);
  const rows = await db
    .select(SELECTION)
    .from(writeApprovals)
    .leftJoin(projects, eq(writeApprovals.projectId, projects.id))
    .leftJoin(
      projectDatabases,
      eq(writeApprovals.projectDatabaseId, projectDatabases.id),
    )
    .leftJoin(user, eq(writeApprovals.decidedByUserId, user.id))
    // LEFT joins throughout: a revoked token or deleted account must not drop
    // the approval from an accountability surface.
    .leftJoin(mcpTokens, eq(writeApprovals.mcpTokenId, mcpTokens.id))
    .leftJoin(requester, eq(mcpTokens.createdByUserId, requester.id))
    // The EXECUTED row for the attempt that consumed this grant. Joined on
    // claimed_query_id, NOT query_id: the held attempt never ran.
    .leftJoin(
      auditEventsIndex,
      and(
        eq(auditEventsIndex.queryId, writeApprovals.claimedQueryId),
        eq(auditEventsIndex.eventType, "EXECUTED"),
      ),
    )
    .where(
      and(
        eq(writeApprovals.id, id),
        // Scoped to the caller's workspace: a foreign id reads as absent rather
        // than forbidden, so this route never confirms another org's ids exist.
        eq(writeApprovals.customerId, customerId),
        eq(writeApprovals.region, region),
      ),
    )
    .limit(1);
  return rows[0] ? shape(rows[0]) : null;
}

export type DecideResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_decided" | "expired" };

/** Approve or deny a pending request.
 *
 *  The status check lives in the WHERE clause rather than in a prior read: two
 *  approvers clicking at the same moment race inside Postgres and exactly one
 *  update lands, so the loser is told "already decided" instead of silently
 *  overwriting the winner's decision and their note.
 *
 *  Expiry is enforced here as well as by the sweeper. A request whose window
 *  closed cannot be approved late even if the sweeper has not relabelled it
 *  yet — otherwise a slow sweep would quietly widen every window. */
export async function decideApproval(args: {
  region: Region;
  customerId: string;
  id: string;
  decision: "approved" | "denied";
  userId: string;
  note: string | null;
  now?: () => number;
}): Promise<DecideResult> {
  const now = args.now ?? Date.now;
  const at = new Date(now());
  const db = getDb(args.region);

  const updated = await db
    .update(writeApprovals)
    .set({
      status: args.decision,
      decidedByUserId: args.userId,
      decisionNote: args.note?.trim() ? args.note.trim() : null,
      decidedAt: at,
    })
    .where(
      and(
        eq(writeApprovals.id, args.id),
        eq(writeApprovals.customerId, args.customerId),
        eq(writeApprovals.region, args.region),
        eq(writeApprovals.status, "pending"),
        // The deadline belongs IN the atomic update, not after it. Marking a
        // row approved and correcting it a moment later opens a window where an
        // engine poll can claim the grant and execute a write past its expiry —
        // the corrective UPDATE then arrives too late to matter. With the
        // predicate here, an expired request simply never becomes approved.
        gt(writeApprovals.expiresAt, at),
      ),
    )
    .returning({ id: writeApprovals.id });

  if (updated.length === 0) {
    // Nothing matched. Read back to say WHICH precondition failed, so the
    // approver gets "someone else decided" vs "it expired" rather than a
    // generic refusal.
    const existing = await getApproval(args.region, args.customerId, args.id);
    if (!existing) return { ok: false, error: "not_found" };
    if (existing.status !== "pending") return { ok: false, error: "already_decided" };

    // Still pending, so the deadline is what refused us. Relabel it now rather
    // than waiting for the sweeper, so the queue stops offering an action that
    // cannot succeed. Conditional and idempotent — and note it never passes
    // through 'approved', which is precisely what made the old ordering racy.
    await db
      .update(writeApprovals)
      .set({ status: "expired", decidedAt: at })
      .where(
        and(
          eq(writeApprovals.id, args.id),
          eq(writeApprovals.status, "pending"),
          lte(writeApprovals.expiresAt, at),
        ),
      );
    return { ok: false, error: "expired" };
  }

  return { ok: true };
}

const SELECTION = {
  id: writeApprovals.id,
  projectId: writeApprovals.projectId,
  projectName: projects.name,
  database: projectDatabases.name,
  sqlText: writeApprovals.sqlText,
  intent: writeApprovals.intent,
  statementType: writeApprovals.statementType,
  tablesTouched: writeApprovals.tablesTouched,
  agentName: writeApprovals.agentName,
  status: writeApprovals.status,
  decidedByUserId: writeApprovals.decidedByUserId,
  decidedByName: user.name,
  decidedByEmail: user.email,
  requestedByName: requester.name,
  requestedByEmail: requester.email,
  agentKind: mcpTokens.kind,
  executedAuditId: auditEventsIndex.id,
  executedPayload: auditEventsIndex.payload,
  executedAt: auditEventsIndex.ts,
  decisionNote: writeApprovals.decisionNote,
  decidedAt: writeApprovals.decidedAt,
  expiresAt: writeApprovals.expiresAt,
  createdAt: writeApprovals.createdAt,
};

type RawRow = {
  [K in keyof typeof SELECTION]: unknown;
};

function shape(r: RawRow): QueueRow {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    projectName: (r.projectName as string | null) ?? null,
    // The database row can be gone (cascade races a settled approval); the
    // queue still renders rather than 500-ing on a dangling join.
    database: (r.database as string | null) ?? "—",
    sqlText: r.sqlText as string,
    intent: r.intent as string,
    statementType: r.statementType as string,
    tablesTouched: (r.tablesTouched as string[] | null) ?? [],
    agentName: (r.agentName as string | null) ?? null,
    status: r.status as string,
    decidedByUserId: (r.decidedByUserId as string | null) ?? null,
    decidedByName:
      ((r.decidedByName as string | null)?.trim() ||
        (r.decidedByEmail as string | null)?.trim()) ??
      null,
    requestedByName:
      ((r.requestedByName as string | null)?.trim() ||
        (r.requestedByEmail as string | null)?.trim()) ??
      null,
    agentKind: (r.agentKind as string | null) ?? null,
    executedAuditId: (r.executedAuditId as string | null) ?? null,
    executedRowsAffected: rowsAffected(r.executedPayload),
    executedAt: (r.executedAt as Date | null) ?? null,
    decisionNote: (r.decisionNote as string | null) ?? null,
    decidedAt: (r.decidedAt as Date | null) ?? null,
    expiresAt: r.expiresAt as Date,
    createdAt: r.createdAt as Date,
  };
}

async function selectRows(
  region: Region,
  customerId: string,
  status: WriteApprovalStatus,
  limit: number,
): Promise<QueueRow[]> {
  const db = getDb(region);
  const rows = await db
    .select(SELECTION)
    .from(writeApprovals)
    .leftJoin(projects, eq(writeApprovals.projectId, projects.id))
    .leftJoin(
      projectDatabases,
      eq(writeApprovals.projectDatabaseId, projectDatabases.id),
    )
    .leftJoin(user, eq(writeApprovals.decidedByUserId, user.id))
    // LEFT joins throughout: a revoked token or deleted account must not drop
    // the approval from an accountability surface.
    .leftJoin(mcpTokens, eq(writeApprovals.mcpTokenId, mcpTokens.id))
    .leftJoin(requester, eq(mcpTokens.createdByUserId, requester.id))
    // The EXECUTED row for the attempt that consumed this grant. Joined on
    // claimed_query_id, NOT query_id: the held attempt never ran.
    .leftJoin(
      auditEventsIndex,
      and(
        eq(auditEventsIndex.queryId, writeApprovals.claimedQueryId),
        eq(auditEventsIndex.eventType, "EXECUTED"),
      ),
    )
    .where(
      and(
        eq(writeApprovals.customerId, customerId),
        eq(writeApprovals.region, region),
        eq(writeApprovals.status, status),
      ),
    )
    .orderBy(desc(writeApprovals.createdAt))
    .limit(limit);
  return rows.map(shape);
}

/** rows_affected from an EXECUTED payload (INSERT/UPDATE/DELETE), falling back
 *  to rows_returned so a RETURNING statement still reports something. Undefined
 *  on both is a legitimate shape, not an error — report null rather than 0,
 *  since "we don't know" and "it changed nothing" are different claims. */
function rowsAffected(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.rows_affected === "number") return p.rows_affected;
  if (typeof p.rows_returned === "number") return p.rows_returned;
  return null;
}
