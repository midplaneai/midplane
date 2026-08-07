import Link from "next/link";

import { cn } from "@/lib/utils";

// Shared vocabulary for the two approval surfaces.
//
// The design problem these solve: an approval card is a pile of values from
// four different places — the agent, the policy, the project, the clock — and
// unlabelled they read as noise. "mp-test · mp-test" is the worst case: project
// and database frequently share a name, so without labels the reader cannot
// tell which half is which, or that there are two halves at all.
//
// Every value therefore gets a lowercase-mono label in --subtle (DESIGN.md's
// product voice) sitting in one narrow left column, so the eye reads one
// alignment instead of four.

/** Definition list for request metadata. One column of labels, one of values —
 *  the label column is deliberately narrow and fixed so values align. */
export function MetaList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
      {children}
    </dl>
  );
}

export function MetaRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  /** Values that are identifiers rather than prose — names, paths, agents. */
  mono?: boolean;
}) {
  return (
    <>
      <dt className="whitespace-nowrap pt-px font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 text-[13px] text-foreground",
          mono && "font-mono text-xs",
        )}
      >
        {children}
      </dd>
    </>
  );
}

/** project : database, with the brand colon separator the breadcrumb uses.
 *
 *  The colon is what makes a repeated name legible — "mp-test : mp-test" reads
 *  as two segments where "mp-test · mp-test" read as a stutter. Both halves are
 *  labelled on the detail page; this compact form is for the list, where a
 *  column header cannot carry two names. */
export function TargetPath({
  project,
  database,
  className,
}: {
  project: string;
  database: string;
  className?: string;
}) {
  return (
    <span
      className={cn("font-mono text-xs text-foreground", className)}
      title={`project ${project}, database ${database}`}
    >
      {project}
      <span aria-hidden className="px-1 font-bold text-[hsl(var(--brand))]">
        :
      </span>
      {database}
    </span>
  );
}

/** One statement, rendered as the decision object it is.
 *
 *  Leads the card rather than sitting under a synthesized "INSERT on events"
 *  title: that title restated what the SQL already says, and pushed the one
 *  thing the approver is actually judging into the middle of the layout.
 *
 *  This is also the ONLY place a statement renders — it never leaves the region
 *  in a notification, because a WHERE clause routinely carries live values. */
export function Statement({ sql }: { sql: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
      {sql}
    </pre>
  );
}

/** The statement, and the row's click target.
 *
 *  Stretched-link pattern, same as the audit log: the <tr> is `relative` and
 *  this anchor's `before:absolute before:inset-0` pseudo-element fills the whole
 *  row. ONE anchor — so middle-click opens a tab, keyboard nav reaches it once,
 *  and the accessible name is the statement rather than a timestamp.
 *
 *  Anything interactive elsewhere in the row must sit above this overlay
 *  (`relative z-10`) or it becomes unclickable. That is the cost of the pattern,
 *  and the reason the audit log's rows — which contain nothing interactive —
 *  could adopt it without qualification and ours cannot. */
export function StatementLink({ id, sql }: { id: string; sql: string }) {
  return (
    <Link
      href={`/approvals/${id}`}
      className="block truncate font-mono text-xs text-foreground before:absolute before:inset-0 before:z-0 before:content-[''] hover:underline"
    >
      {sql}
    </Link>
  );
}
