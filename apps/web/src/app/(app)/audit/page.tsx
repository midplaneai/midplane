import Link from "next/link";
import { redirect } from "next/navigation";

import { EventBadge } from "@/components/audit/event-badge";
import { FilterChips } from "@/components/audit/filter-chips";
import { relativeTime } from "@/components/audit/relative-time";
import {
  StalenessBanner,
  StalenessSubtitle,
} from "@/components/audit/staleness-banner";
import { VolumeSparkline } from "@/components/audit/volume-sparkline";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  countByEventType,
  EVENT_TYPES,
  eventVolumeByHour,
  listAuditEvents,
  listDatabases,
  listTenantIds,
  readStaleness,
  type EventType,
} from "@/lib/audit";
import { currentCustomer } from "@/lib/customer";

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{
    event_type?: string;
    tenant_id?: string;
    database?: string;
    q?: string;
    cursor?: string;
  }>;
}

export default async function AuditListPage({ searchParams }: PageProps) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const params = await searchParams;
  const selectedTypes = parseEventTypes(params.event_type);
  const selectedTenant = params.tenant_id?.trim() || null;
  const selectedDatabase = params.database?.trim() || null;
  const search = params.q?.trim() ?? "";
  const cursor = params.cursor?.trim() || undefined;

  const [list, tenants, databases, counts, volume, staleness] =
    await Promise.all([
      listAuditEvents(customer.id, {
        region: customer.region,
        eventTypes: selectedTypes,
        tenantId: selectedTenant ?? undefined,
        database: selectedDatabase ?? undefined,
        search,
        cursor,
        pageSize: PAGE_SIZE,
      }),
      listTenantIds(customer.id, customer.region),
      listDatabases(customer.id, customer.region),
      countByEventType(customer.id, customer.region),
      eventVolumeByHour(customer.id, customer.region, {
        tenantId: selectedTenant ?? undefined,
        database: selectedDatabase ?? undefined,
        search,
      }),
      readStaleness(customer.id, customer.region),
    ]);

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const hasFilters =
    selectedTypes.length > 0 ||
    selectedTenant !== null ||
    selectedDatabase !== null ||
    search.length > 0;

  const buildUrl = makeUrlBuilder({
    selectedTypes,
    selectedTenant,
    selectedDatabase,
    search,
    cursor,
  });

  return (
    <>
      <Topbar>
        <b className="font-medium text-foreground">{customer.email}</b>
        <span className="mx-2 text-subtle">/</span>Audit log
      </Topbar>
      <PageContainer>
        <PageHeader title="Audit log" />
        <StalenessSubtitle read={staleness} totalCount={totalCount} />
        <StalenessBanner read={staleness} />

        <VolumeSparkline buckets={volume} />

        <FilterChips
          selectedTypes={selectedTypes}
          selectedTenant={selectedTenant}
          selectedDatabase={selectedDatabase}
          tenants={tenants}
          databases={databases}
          counts={counts}
          search={search}
          buildUrl={buildUrl}
        />

        {list.rows.length === 0 ? (
          <AuditEmpty hasFilters={hasFilters} />
        ) : (
          <table
            className="w-full border-collapse text-xs"
            data-testid="audit-table"
          >
            <thead>
              <tr>
                <Th width="13%">Time</Th>
                <Th width="13%">Event</Th>
                <Th width="16%">Agent</Th>
                <Th width="16%">Query ID</Th>
                <Th>SQL fingerprint</Th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr
                  key={r.id}
                  data-testid="audit-row"
                  data-event-type={r.eventType}
                  data-tenant-id={r.tenantId}
                  className="border-b border-card transition-colors hover:bg-card"
                >
                  <Td className="whitespace-nowrap font-mono text-[11px] text-subtle">
                    <Link href={`/audit/${r.id}`}>{relativeTime(r.ts)}</Link>
                  </Td>
                  <Td>
                    <Link href={`/audit/${r.id}`}>
                      <EventBadge eventType={r.eventType} />
                    </Link>
                  </Td>
                  <Td>
                    <Link href={`/audit/${r.id}`}>
                      {r.agentIdentity ? (
                        <span className="rounded-[3px] border border-border bg-secondary px-1.5 py-px font-mono text-[10px] text-subtle">
                          {r.agentIdentity}
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      href={`/audit/${r.id}`}
                      className="font-mono text-[11px] text-subtle"
                    >
                      {truncate(r.queryId, 16)}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      href={`/audit/${r.id}`}
                      title={r.sqlFingerprint ?? undefined}
                      className="block max-w-[340px] truncate font-mono text-xs text-foreground"
                    >
                      {r.sqlFingerprint ?? (
                        <span className="text-subtle">—</span>
                      )}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(list.rows.length > 0 || cursor) && (
          <div className="flex items-center gap-2.5 py-4 text-[11px] text-subtle">
            <span>
              Showing{" "}
              <span className="font-mono">
                {list.rows.length.toLocaleString()}
              </span>
              {!hasFilters && totalCount > 0 && (
                <>
                  {" "}
                  of{" "}
                  <span className="font-mono">
                    {totalCount.toLocaleString()}
                  </span>
                </>
              )}
              {hasFilters && " matching"}
            </span>
            <div className="ml-auto flex gap-1">
              <PageLink
                href={buildUrl({ cursor: null })}
                disabled={!cursor}
                label="← Newest"
              />
              <PageLink
                href={
                  list.nextCursor ? buildUrl({ cursor: list.nextCursor }) : "#"
                }
                disabled={!list.nextCursor}
                label="Older →"
              />
            </div>
          </div>
        )}
      </PageContainer>
    </>
  );
}

function Th({ children, width }: { children: React.ReactNode; width?: string }) {
  return (
    <th
      style={width ? { width } : undefined}
      className="border-b border-border px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.02em] text-subtle"
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

function PageLink({
  href,
  disabled,
  label,
}: {
  href: string;
  disabled: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded border border-border bg-secondary px-2.5 py-0.5 font-mono text-[11px] text-subtle transition-colors",
        disabled
          ? "pointer-events-none opacity-40"
          : "hover:border-border-strong hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

function AuditEmpty({ hasFilters }: { hasFilters: boolean }) {
  if (hasFilters) {
    return (
      <EmptyState
        title="No matching audit rows"
        description="Try clearing a filter, or widen the search term."
      />
    );
  }
  return (
    <EmptyState title="No queries yet.">
      <p className="text-sm text-muted-foreground">
        Once you wire up your agent, queries will appear here.{" "}
        <Link
          href="/dashboard"
          className="text-[hsl(var(--brand))] underline underline-offset-2"
        >
          Connect a database →
        </Link>
      </p>
      <pre className="mt-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {`agent ─▶ MCP token ─▶ midplane engine ─▶ your Postgres
                              │
                              └─▶ audit_events ──▶ this dashboard`}
      </pre>
    </EmptyState>
  );
}

function parseEventTypes(raw: string | undefined): readonly EventType[] {
  if (!raw) return [];
  const valid = new Set<string>(EVENT_TYPES);
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is EventType => valid.has(s));
}

function makeUrlBuilder(state: {
  selectedTypes: readonly EventType[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  search: string;
  cursor: string | undefined;
}) {
  return (overrides: {
    eventType?: readonly EventType[];
    tenantId?: string | null;
    database?: string | null;
    cursor?: string | null;
  }): string => {
    const types =
      overrides.eventType !== undefined
        ? overrides.eventType
        : state.selectedTypes;
    const tenant =
      overrides.tenantId !== undefined
        ? overrides.tenantId
        : state.selectedTenant;
    const database =
      overrides.database !== undefined
        ? overrides.database
        : state.selectedDatabase;
    const cursor =
      overrides.cursor !== undefined ? overrides.cursor : state.cursor;
    const usp = new URLSearchParams();
    if (types.length > 0) usp.set("event_type", types.join(","));
    if (tenant) usp.set("tenant_id", tenant);
    if (database) usp.set("database", database);
    if (state.search) usp.set("q", state.search);
    if (cursor) usp.set("cursor", cursor);
    const q = usp.toString();
    return q ? `/audit?${q}` : "/audit";
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
