import { cn } from "@/lib/utils";
import { classifySql, SQL_KIND_LABELS, type SqlKind } from "@/lib/sql-kind";

// Read / write / DDL tag for the audit list SQL column. Kept NEUTRAL on
// purpose: statement kind is not a query-lifecycle decision, and DESIGN
// reserves the semantic palette (allow/deny/warn) for decisions. The
// scan signal is the label plus a subtle weight ramp — reads sit back in
// `--subtle`, mutations and schema changes step forward to `--foreground`
// with a stronger hairline so they catch the eye in a long list.
const KIND_CLASS: Record<Exclude<SqlKind, "other">, string> = {
  read: "border-border text-subtle",
  write: "border-border-strong text-foreground",
  ddl: "border-border-strong text-foreground font-medium",
};

export function SqlKindBadge({ sql }: { sql: string | null | undefined }) {
  const kind = classifySql(sql);
  if (!kind || kind === "other") return null;
  return (
    <span
      data-sql-kind={kind}
      aria-label={`${SQL_KIND_LABELS[kind]} statement`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-[3px] border bg-secondary px-1 py-px font-mono text-[9px] uppercase tracking-[0.04em]",
        KIND_CLASS[kind],
      )}
    >
      {SQL_KIND_LABELS[kind]}
    </span>
  );
}
