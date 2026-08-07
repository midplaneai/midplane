import { notFound, redirect } from "next/navigation";
import Link from "next/link";

// One approval request — the deciding surface.
//
// Reading order follows the decision: WHAT would run, then WHO is asking and
// why, then act. The statement leads, because it is the thing being judged; the
// previous layout led with a synthesized "INSERT on events" title that only
// restated the SQL sitting below it.
//
// Every metadata value carries a lowercase-mono label in one narrow column.
// Unlabelled, this page was a pile of values from four different sources and
// the reader had no way to tell which was which — "mp-test · mp-test" being the
// worst case, since project and database routinely share a name.
//
// This is the route the engine hands the agent (`review_url`) and that every
// notification email links to, so it must be openable by whoever got the mail.
// A member can read it; only owner/admin get the controls.

import { currentCustomer } from "@/lib/customer";
import { getActiveRole } from "@/lib/org-auth";
import { isManagerRole } from "@/lib/org-roles";
import { getApproval, type QueueRow } from "@/lib/approval-queue";
import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { ApprovalDecisionForm } from "@/components/approvals/approval-decision-form";
import {
  MetaList,
  MetaRow,
  Statement,
  TargetPath,
} from "@/components/approvals/approval-meta";
import { Countdown } from "@/components/approvals/countdown";
import { absoluteTime, relativeTime } from "@/components/audit/relative-time";

export const dynamic = "force-dynamic";

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  const { id } = await params;
  // Scoped to the caller's workspace, so another org's id reads as absent
  // rather than forbidden — this route never confirms foreign ids exist.
  const row = await getApproval(customer.region, customer.id, id);
  if (!row) notFound();

  const role = await getActiveRole();
  const pending = row.status === "pending";
  const canDecide = isManagerRole(role?.role) && pending;

  return (
    <>
      <Topbar>
        {/* The breadcrumb IS the way back — DESIGN.md says ship the primitive
            rather than inlining a link. */}
        <Breadcrumb
          items={[
            { label: "Approvals", href: "/approvals" },
            { label: row.statementType.toLowerCase() },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="max-w-[860px]">
          {/* Status line: what state, and how long is left. Nothing else — the
              detail belongs in the labelled block below, not floating here. */}
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Status row={row} />
            {pending ? (
              <>
                {/* The clock is the pressure — sized up and ticking, because a
                    static number on a tab left open for half an hour lies. */}
                <Countdown
                  expiresAt={row.expiresAt.toISOString()}
                  title={absoluteTime(row.expiresAt)}
                  className="text-lg font-medium"
                />
                <span className="text-xs text-subtle">
                  until this is denied automatically
                </span>
              </>
            ) : (
              <span
                className="text-xs text-muted-foreground"
                title={absoluteTime(row.decidedAt ?? row.createdAt)}
              >
                {relativeTime(row.decidedAt ?? row.createdAt)}
              </span>
            )}
          </div>

          <section className="border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <span className="mb-2 block font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
                statement
              </span>
              <Statement sql={row.sqlText} />
            </div>

            <div className="border-b border-border px-4 py-3.5">
              <MetaList>
                <MetaRow label="requested by">
                  <Requester
                    agentName={row.agentName}
                    agentKind={row.agentKind}
                    person={row.requestedByName}
                  />
                </MetaRow>
                {row.intent ? (
                  <MetaRow label="intent">{row.intent}</MetaRow>
                ) : null}
                <MetaRow label="target">
                  <TargetPath
                    project={row.projectName ?? row.projectId}
                    database={row.database}
                  />
                </MetaRow>
                <MetaRow label="tables" mono>
                  {row.tablesTouched.length > 0 ? (
                    row.tablesTouched.join(", ")
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </MetaRow>
                <MetaRow label="waiting">
                  <span title={absoluteTime(row.createdAt)}>
                    {/* relativeTime answers "how long ago"; as a duration next
                        to the countdown the trailing "ago" is just noise. */}
                    {relativeTime(row.createdAt).replace(/ ago$/, "")}
                  </span>
                </MetaRow>
              </MetaList>
            </div>

            {!pending ? (
              <div className="px-4 py-3.5">
                <MetaList>
                  <MetaRow label="outcome">
                    {row.status === "expired" ? (
                      "Expired before anyone responded. The agent can ask again."
                    ) : (
                      <>
                        {row.status === "approved" ? "Approved" : "Denied"}
                        {row.decidedByName
                          ? ` by ${row.decidedByName}`
                          : row.decidedByUserId
                            ? " by a since-deleted account"
                            : ""}
                      </>
                    )}
                  </MetaRow>
                  {row.decisionNote ? (
                    <MetaRow label="note">{row.decisionNote}</MetaRow>
                  ) : null}
                  {row.status === "approved" ? (
                    <MetaRow label="result">
                      {row.executedAuditId ? (
                        <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                          <span>
                            Executed
                            {row.executedRowsAffected !== null
                              ? ` — ${row.executedRowsAffected.toLocaleString()} row${
                                  row.executedRowsAffected === 1 ? "" : "s"
                                }`
                              : ""}
                          </span>
                          <Link
                            href={`/audit/${row.executedAuditId}`}
                            className="text-xs underline underline-offset-2"
                          >
                            audit entry
                          </Link>
                        </span>
                      ) : (
                        // Approved but not yet collected. A real state, not an
                        // error: the agent has to come back and re-run, and may
                        // not have yet.
                        <span className="text-subtle">
                          Approved, not yet run — the agent has not collected
                          it.
                        </span>
                      )}
                    </MetaRow>
                  ) : null}
                </MetaList>
              </div>
            ) : canDecide ? (
              <div className="px-4 py-3.5">
                <ApprovalDecisionForm id={row.id} redirectTo="/approvals" />
              </div>
            ) : (
              <div className="px-4 py-3.5 text-xs text-muted-foreground">
                Waiting on the workspace owner or an admin.
              </div>
            )}
          </section>
        </div>
      </PageContainer>
    </>
  );
}

/** "claude-code on behalf of Dustin Lange" — one fact, one sentence.
 *
 *  Agent and person were two rows, which made the reader assemble the
 *  relationship themselves. They are not independent values: the agent acts FOR
 *  the person, and that phrasing is what makes the row answer "who is asking".
 *
 *  A machine token gets different wording on purpose. "on behalf of" implies
 *  someone is at the keyboard; for an unattended token the person minted the
 *  credential and may have no idea it is running right now, which is precisely
 *  the case deserving more scrutiny rather than less. */
function Requester({
  agentName,
  agentKind,
  person,
}: {
  agentName: string | null;
  agentKind: string | null;
  person: string | null;
}) {
  const agent = agentName ?? "an unidentified agent";
  const machine = agentKind === "url";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span className="font-mono text-xs text-foreground">{agent}</span>
      {machine ? <Badge variant="warn">MACHINE TOKEN</Badge> : null}
      {person ? (
        <>
          <span className="text-muted-foreground">
            {machine ? "created by" : "on behalf of"}
          </span>
          <span className="text-foreground">{person}</span>
        </>
      ) : (
        <span className="text-subtle">— no live owner on its token</span>
      )}
    </span>
  );
}

function Status({ row }: { row: QueueRow }) {
  if (row.status === "approved") return <Badge variant="allow">APPROVED</Badge>;
  if (row.status === "denied") return <Badge variant="deny">DENIED</Badge>;
  if (row.status === "expired") return <Badge variant="deny">EXPIRED</Badge>;
  return <Badge variant="warn">PENDING</Badge>;
}
