import { redirect } from "next/navigation";
import Link from "next/link";

// Cross-project approval queue.
//
// A LIST, not a stack of cards. The earlier card layout gave one pending
// request the same weight as a whole page and scattered its values across four
// alignments; at five requests it would have been unreadable. This mirrors the
// audit log — the sibling oversight surface — so the two read as one system:
// mono lowercase headers, 12px body, hover row, click through for detail.
//
// Deliberately not per-project: an approver thinks in terms of "what is waiting
// on me", not "which project was that in". Costs nothing — a workspace is
// single-region by construction, so the whole queue is one indexed read on
// (customer_id, region, status, created_at).
//
// A MEMBER sees this read-only. They are frequently the person whose agent is
// blocked, and hiding the queue would leave them staring at "awaiting approval"
// with no way to learn why. The decide controls are owner/admin, and
// `decideAction` re-checks server-side — a hidden button is not a permission.

import { currentCustomer } from "@/lib/customer";
import { getActiveRole } from "@/lib/org-auth";
import { isManagerRole } from "@/lib/org-roles";
import {
  listDecidedApprovals,
  listPendingApprovals,
  type QueueRow,
} from "@/lib/approval-queue";
import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { QuickDecideForm } from "@/components/approvals/approval-decision-form";
import {
  StatementLink,
  TargetPath,
} from "@/components/approvals/approval-meta";
import { Countdown } from "@/components/approvals/countdown";
import { relativeTime } from "@/components/audit/relative-time";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  const role = await getActiveRole();
  const canDecide = isManagerRole(role?.role);

  const { tab } = await searchParams;
  const showDecided = tab === "decided";

  const [pending, decided] = await Promise.all([
    listPendingApprovals(customer.region, customer.id),
    showDecided
      ? listDecidedApprovals(customer.region, customer.id)
      : Promise.resolve([] as QueueRow[]),
  ]);
  const rows = showDecided ? decided : pending;

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Approvals" }]} />
      </Topbar>
      <PageContainer>
        <PageHeader
          title="Approvals"
          subtitle="Writes an agent is holding until someone signs off. A request nobody answers expires into a denial — silence is never a yes."
        />

        <nav
          className="mb-5 flex gap-5 border-b border-border"
          aria-label="Approval status"
        >
          <Tab href="/approvals" active={!showDecided}>
            Pending
            {pending.length > 0 && (
              <span className="ml-1.5 font-mono text-[11px] tabular-nums text-subtle">
                {pending.length}
              </span>
            )}
          </Tab>
          <Tab href="/approvals?tab=decided" active={showDecided}>
            Decided
          </Tab>
        </nav>

        {!canDecide && !showDecided && rows.length > 0 && (
          <p className="mb-4 border-l-[3px] border-border-strong bg-secondary px-3 py-2 text-xs text-muted-foreground">
            You can see what your agents are waiting on.{" "}
            <strong className="font-medium text-foreground">
              Only the workspace owner and admins can decide.
            </strong>
          </p>
        )}

        {rows.length === 0 ? (
          <EmptyState
            title={showDecided ? "Nothing decided yet" : "Nothing waiting"}
            description={
              showDecided
                ? "Approved and denied requests show up here once someone acts on them."
                : "Agents are running inside policy. When one asks for something that needs a human, it shows up here."
            }
          />
        ) : (
          <div className="border border-border bg-card">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  {showDecided ? (
                    <>
                      <Th width="9%">decided</Th>
                      <Th width="11%">outcome</Th>
                      <Th width="15%">by</Th>
                      <Th>statement</Th>
                      <Th width="17%">project : database</Th>
                    </>
                  ) : (
                    <>
                      <Th width="8%">expires</Th>
                      <Th>statement</Th>
                      <Th width="17%">project : database</Th>
                      <Th width="15%">agent</Th>
                      {canDecide && <Th width="15%" align="right" />}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) =>
                  showDecided ? (
                    <DecidedRow key={r.id} row={r} />
                  ) : (
                    <PendingRow key={r.id} row={r} canDecide={canDecide} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}

        {!showDecided && rows.length > 0 && (
          <p className="mt-3 text-[11px] text-subtle">
            An approval authorizes that exact statement, once. If the agent
            rewrites the query it asks again.
          </p>
        )}
      </PageContainer>
    </>
  );
}

function PendingRow({ row, canDecide }: { row: QueueRow; canDecide: boolean }) {
  return (
    <tr className="relative border-b border-card last:border-b-0 hover:bg-secondary/40">
      <Td>
        <Countdown
          expiresAt={row.expiresAt.toISOString()}
          title={row.expiresAt.toISOString()}
          className="text-xs"
        />
      </Td>
      <Td className="max-w-0">
        <StatementLink id={row.id} sql={row.sqlText} />
        {row.intent ? (
          <span
            className="mt-0.5 block truncate text-[11px] text-muted-foreground"
            title={row.intent}
          >
            {row.intent}
          </span>
        ) : null}
      </Td>
      <Td>
        <TargetPath
          project={row.projectName ?? row.projectId}
          database={row.database}
        />
      </Td>
      <Td>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {row.agentName ?? "—"}
        </span>
        {row.requestedByName ? (
          <span
            className="block truncate text-[11px] text-subtle"
            title={
              row.agentKind === "url"
                ? `machine token created by ${row.requestedByName}`
                : `on behalf of ${row.requestedByName}`
            }
          >
            {row.agentKind === "url" ? "token of " : "for "}
            {row.requestedByName}
          </span>
        ) : null}
      </Td>
      {canDecide && (
        // z-10 lifts the buttons above the row-wide link overlay. Without it
        // Approve/Deny become unclickable and every attempt navigates instead —
        // which on this surface would be worse than a dead row, because the user
        // believes they decided something.
        <Td className="relative z-10 text-right">
          <QuickDecideForm id={row.id} />
        </Td>
      )}
    </tr>
  );
}

function DecidedRow({ row }: { row: QueueRow }) {
  const denied = row.status !== "approved";
  return (
    <tr
      className={cn(
        "relative border-b border-card last:border-b-0 hover:bg-secondary/40",
        // Deny rows carry the audit log's blush tint — same vocabulary, so a
        // refusal reads the same on both oversight surfaces.
        denied && "bg-[hsl(var(--deny-tint)/0.06)]",
      )}
    >
      <Td className="whitespace-nowrap font-mono text-[11px] text-subtle">
        {relativeTime(row.decidedAt ?? row.createdAt)}
      </Td>
      <Td>
        <Outcome status={row.status} />
        {row.status === "approved" ? (
          <span className="mt-0.5 block whitespace-nowrap text-[11px] text-subtle">
            {row.executedAuditId
              ? row.executedRowsAffected !== null
                ? `ran · ${row.executedRowsAffected.toLocaleString()} row${
                    row.executedRowsAffected === 1 ? "" : "s"
                  }`
                : "ran"
              : "not yet run"}
          </span>
        ) : null}
      </Td>
      <Td className="text-[11px]">
        {row.decidedByName ?? (
          <span className="text-subtle">
            {row.status === "expired" ? "no one answered" : "—"}
          </span>
        )}
      </Td>
      <Td className="max-w-0">
        <StatementLink id={row.id} sql={row.sqlText} />
        {row.decisionNote ? (
          <span
            className="mt-0.5 block truncate text-[11px] text-muted-foreground"
            title={row.decisionNote}
          >
            &ldquo;{row.decisionNote}&rdquo;
          </span>
        ) : null}
      </Td>
      <Td>
        <TargetPath
          project={row.projectName ?? row.projectId}
          database={row.database}
        />
      </Td>
    </tr>
  );
}

function Outcome({ status }: { status: string }) {
  if (status === "approved") return <Badge variant="allow">APPROVED</Badge>;
  if (status === "denied") return <Badge variant="deny">DENIED</Badge>;
  return <Badge variant="deny">EXPIRED</Badge>;
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px border-b-2 pb-2 text-sm transition-colors",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-subtle hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function Th({
  children,
  width,
  align,
}: {
  children?: React.ReactNode;
  width?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      style={width ? { width } : undefined}
      className={cn(
        "border-b border-border px-3 py-2 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("px-3 py-2.5 align-middle text-foreground", className)}>
      {children}
    </td>
  );
}
