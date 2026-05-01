import Link from "next/link";

import { cn } from "@/lib/utils";
import { EVENT_TYPES, type EventType } from "@/lib/audit";

interface FilterChipsProps {
  selectedTypes: readonly EventType[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  tenants: readonly string[];
  databases: readonly string[];
  counts: Record<EventType, number>;
  search: string;
  buildUrl: (overrides: {
    eventType?: readonly EventType[];
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

export function FilterChips({
  selectedTypes,
  selectedTenant,
  selectedDatabase,
  tenants,
  databases,
  counts,
  search,
  buildUrl,
}: FilterChipsProps) {
  const allTypesActive = selectedTypes.length === 0;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
      <span className={cn(CHIP_LABEL, "mr-1")}>Event</span>
      <Chip
        href={buildUrl({ eventType: [], cursor: null })}
        active={allTypesActive}
      >
        <b className="font-medium">All</b>
      </Chip>
      {EVENT_TYPES.map((t) => {
        const active = selectedTypes.includes(t);
        const next = active
          ? selectedTypes.filter((x) => x !== t)
          : [...selectedTypes, t];
        return (
          <Chip
            key={t}
            href={buildUrl({ eventType: next, cursor: null })}
            active={active}
          >
            <b className="font-medium">
              {t.charAt(0) + t.slice(1).toLowerCase()}
            </b>
            <Count active={active}>{counts[t]}</Count>
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
        {selectedTypes.length > 0 && (
          <input
            type="hidden"
            name="event_type"
            value={selectedTypes.join(",")}
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
          placeholder="Search query_id or sql_fingerprint…"
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
