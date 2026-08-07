// Telling humans a write is waiting on them.
//
// LINK-ONLY, by construction rather than by discipline. Every outbound payload
// here carries ids, a database ALIAS, an agent name, and a URL. Never the SQL,
// never the table names.
//
// The reason is not squeamishness. Table and column names are customer schema,
// and a held DELETE's WHERE clause routinely carries live VALUES — an email
// address, an account id — so the statement is DATA, not metadata. Email leaves
// the region entirely, lands in an inbox outside the customer's control, and is
// retained by a third party indefinitely. The statement renders in-app, where it
// is org-scoped and region-resident.
//
// This is also why "approve from Slack" is a product decision rather than a
// delivery detail: under this rule the message can show who and how big, but not
// what — so a one-click approval there is an approval made without reading the
// statement.
//
// FIRE-AND-FORGET. The gate holds the engine's request while a human decides;
// notification must never be on that path. A Resend outage must not turn into
// held writes failing to be held. The in-app queue is authoritative regardless —
// an approver who opens /approvals sees the request whether or not mail sent.

import { and, eq, inArray } from "drizzle-orm";

import { getDb, type Region } from "@midplane-cloud/db";
import { member, user } from "@midplane-cloud/db/auth-schema";

import { isEmailConfigured, sendWriteApprovalEmail } from "./email";

/** Roles that may decide an approval — the same gate /approvals enforces. A
 *  member operates the workspace but does not approve production writes against
 *  it, so mailing them would be asking for something the UI will refuse. */
const APPROVER_ROLES = ["owner", "admin"];

/** Cap per hold. A large org should not turn one agent write into fifty emails;
 *  past this the in-app queue is the surface. */
const MAX_RECIPIENTS = 10;

export interface ApprovalNotification {
  approvalId: string;
  customerId: string;
  projectId: string;
  region: Region;
  /** Agent-facing database ALIAS. Never a table name. */
  database: string;
  agentName: string | null;
  expiresAt: Date;
}

/** Notify approvers that a write is held. Never throws — every failure is
 *  swallowed and logged, because the caller is holding an engine request open. */
export async function notifyApprovalRequested(
  n: ApprovalNotification,
): Promise<void> {
  try {
    if (!isEmailConfigured()) return;

    const recipients = await approverEmails(n.region, n.customerId);
    if (recipients.length === 0) return;

    const url = approvalUrl(n.approvalId);

    // Sequential rather than Promise.all: one bad address must not take out the
    // rest, and this is off the request path so latency is free.
    for (const to of recipients) {
      try {
        await sendWriteApprovalEmail({
          to,
          approvalId: n.approvalId,
          database: n.database,
          agentName: n.agentName,
          expiresAt: n.expiresAt,
          url,
        });
      } catch (err) {
        console.error("[approval-notify] send failed:", errText(err));
      }
    }
  } catch (err) {
    console.error("[approval-notify] notification failed:", errText(err));
  }
}

/** Owner/admin emails for the workspace this approval belongs to. */
async function approverEmails(region: Region, customerId: string): Promise<string[]> {
  const db = getDb(region);

  // customers.org_id is the Better Auth organization the members hang off.
  const { customers } = await import("@midplane-cloud/db");
  const org = await db
    .select({ orgId: customers.orgId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const orgId = org[0]?.orgId;
  if (!orgId) return [];

  const rows = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, APPROVER_ROLES)))
    .limit(MAX_RECIPIENTS);

  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

function approvalUrl(approvalId: string): string {
  const base =
    process.env.MIDPLANE_APP_ORIGIN?.replace(/\/$/, "") ?? "https://app.midplane.ai";
  return `${base}/approvals/${approvalId}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
