import Link from "next/link";

import { cn } from "@/lib/utils";
import { QUERY_STATUSES, type QueryStatus } from "@/lib/audit";

interface FilterChipsProps {
  selectedStatuses: readonly QueryStatus[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  tenants: readonly string[];
  databases: readonly string[];
  counts: Record<QueryStatus, number>;
  search: string;
  buildUrl: (overrides: {
    status?: readonly QueryStatus[];
    tenantId?: string | null;
    database?: string | null;
    cursor?: string | null;
  }) => string;
}

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors";
const CHIP_INACTIVE =
  "border-border bg-secondary text-muted-foreground hover:border-border-strong hover:text-foreground";
const CHIP_ACTIVE =
  "border-border-strong bg-popover text-foreground";
const CHIP_LABEL =
  "text-[11px] font-medium uppercase tracking-[0.04em] text-subtle";

// Short labels for the chips. Differ from StatusBadge labels because the
// chip strip is laid out horizontally and benefits from compact text;
// the badge is in-table where the longer label has room.
const CHIP_LABELS: Record<QueryStatus, string> = {
  ALLOWED: "Allowed",
  DENIED: "Denied",
  FAILED: "Failed",
  STUCK: "Stuck",
  PENDING: "Pending",
};

export function FilterChips({
  selectedStatuses,
  selectedTenant,
  selectedDatabase,
  tenants,
  databases,
  counts,
  search,
  buildUrl,
}: FilterChipsProps) {
  const allStatusesActive = selectedStatuses.length === 0;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
      <span className={cn(CHIP_LABEL, "mr-1")}>Status</span>
      <Chip
        href={buildUrl({ status: [], cursor: null })}
        active={allStatusesActive}
      >
        <b className="font-medium">All</b>
      </Chip>
      {QUERY_STATUSES.map((s) => {
        const active = selectedStatuses.includes(s);
        const next = active
          ? selectedStatuses.filter((x) => x !== s)
          : [...selectedStatuses, s];
        return (
          <Chip
            key={s}
            href={buildUrl({ status: next, cursor: null })}
            active={active}
          >
            <b className="font-medium">{CHIP_LABELS[s]}</b>
            <Count active={active}>{counts[s]}</Count>
          </Chip>
        );
      })}

      {tenants.length > 0 && (
        <>
          <span className={cn(CHIP_LABEL, "ml-3 mr-1")}>Tenant</span>
          <Chip
            href={buildUrl({ tenantId: null, cursor: null })}
            active={selectedTenant === null}
          >
            <b className="font-medium">All</b>
            <Count active={selectedTenant === null}>{tenants.length}</Count>
          </Chip>
          {tenants.map((t) => (
            <Chip
              key={t}
              href={buildUrl({
                tenantId: selectedTenant === t ? null : t,
                cursor: null,
              })}
              active={selectedTenant === t}
            >
              <b className="font-mono font-medium">{truncate(t, 18)}</b>
            </Chip>
          ))}
        </>
      )}

      {databases.length > 0 && (
        <>
          <span className={cn(CHIP_LABEL, "ml-3 mr-1")}>Database</span>
          <Chip
            href={buildUrl({ database: null, cursor: null })}
            active={selectedDatabase === null}
          >
            <b className="font-medium">All</b>
            <Count active={selectedDatabase === null}>{databases.length}</Count>
          </Chip>
          {databases.map((d) => (
            <Chip
              key={d}
              href={buildUrl({
                database: selectedDatabase === d ? null : d,
                cursor: null,
              })}
              active={selectedDatabase === d}
            >
              <b className="font-mono font-medium">{truncate(d, 18)}</b>
            </Chip>
          ))}
        </>
      )}

      <form action="/audit" method="get" className="ml-auto">
        {selectedStatuses.length > 0 && (
          <input
            type="hidden"
            name="status"
            value={selectedStatuses.join(",")}
          />
        )}
        {selectedTenant && (
          <input type="hidden" name="tenant_id" value={selectedTenant} />
        )}
        {selectedDatabase && (
          <input type="hidden" name="database" value={selectedDatabase} />
        )}
        <input
          name="q"
          defaultValue={search}
          placeholder="Search SQL, fingerprint or query_id…"
          aria-label="Search audit rows"
          className={cn(
            "w-[280px] rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground",
            "focus:border-[hsl(var(--brand))] focus:outline-none",
          )}
        />
      </form>
    </div>
  );
}

function Chip({
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
      className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}
    >
      {children}
    </Link>
  );
}

function Count({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-[3px] px-1.5 py-px font-mono text-[11px] text-muted-foreground",
        active ? "bg-card" : "bg-popover",
      )}
    >
      {children}
    </span>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
