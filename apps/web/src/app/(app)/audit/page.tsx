import Link from "next/link";
import { redirect } from "next/navigation";

import { FilterChips } from "@/components/audit/filter-chips";
import { RefreshButton } from "@/components/audit/refresh-button";
import { relativeTime } from "@/components/audit/relative-time";
import {
  StalenessBanner,
  StalenessSubtitle,
} from "@/components/audit/staleness-banner";
import { StatusBadge } from "@/components/audit/status-badge";
import { VolumeSparkline } from "@/components/audit/volume-sparkline";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  countByStatus,
  eventVolumeByHour,
  listAuditQueries,
  listDatabases,
  listTenantIds,
  QUERY_STATUSES,
  readStaleness,
  type QueryStatus,
} from "@/lib/audit";
import { currentCustomer } from "@/lib/customer";

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{
    status?: string;
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
  const selectedStatuses = parseStatuses(params.status);
  const selectedTenant = params.tenant_id?.trim() || null;
  const selectedDatabase = params.database?.trim() || null;
  const search = params.q?.trim() ?? "";
  const cursor = params.cursor?.trim() || undefined;

  const [list, tenants, databases, counts, volume, staleness] =
    await Promise.all([
      listAuditQueries(customer.id, {
        region: customer.region,
        statuses: selectedStatuses,
        tenantId: selectedTenant ?? undefined,
        database: selectedDatabase ?? undefined,
        search,
        cursor,
        pageSize: PAGE_SIZE,
      }),
      listTenantIds(customer.id, customer.region),
      listDatabases(customer.id, customer.region),
      countByStatus(customer.id, customer.region),
      eventVolumeByHour(customer.id, customer.region, {
        tenantId: selectedTenant ?? undefined,
        database: selectedDatabase ?? undefined,
        search,
      }),
      readStaleness(customer.id, customer.region),
    ]);

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const hasFilters =
    selectedStatuses.length > 0 ||
    selectedTenant !== null ||
    selectedDatabase !== null ||
    search.length > 0;

  const buildUrl = makeUrlBuilder({
    selectedStatuses,
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
        <div className="mb-5 flex items-center justify-between gap-3">
          <StalenessSubtitle read={staleness} totalCount={totalCount} />
          <RefreshButton />
        </div>
        <StalenessBanner read={staleness} />

        <VolumeSparkline buckets={volume} />

        <FilterChips
          selectedStatuses={selectedStatuses}
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
                <Th width="11%">Time</Th>
                <Th width="14%">Status</Th>
                <Th width="14%">Agent</Th>
                <Th width="22%">Intent</Th>
                <Th>SQL</Th>
                <Th width="8%" align="right">
                  Duration
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                // Whole-row click target via the stretched-link pattern:
                // the <tr> is `relative`, the first cell carries a
                // <Link> with a `before:absolute before:inset-0`
                // pseudo-element that fills the row, and the rest of the
                // cells are inert. Single anchor (so middle-click for new
                // tab and keyboard nav still work) and the entire row is
                // clickable, including dead space between cells.
                <tr
                  key={r.attemptedEventId}
                  data-testid="audit-row"
                  data-query-id={r.queryId}
                  data-status={r.status}
                  data-tenant-id={r.tenantId}
                  data-database={r.database}
                  className="relative border-b border-card transition-colors hover:bg-card"
                >
                  <Td className="whitespace-nowrap font-mono text-[11px] text-subtle">
                    <Link
                      href={`/audit/${r.headEventId}`}
                      aria-label={`Open audit event ${r.queryId ?? r.attemptedEventId}`}
                      className="before:absolute before:inset-0 before:z-0 before:content-['']"
                    >
                      {relativeTime(r.startedAt)}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td>
                    <AgentCell
                      name={r.agentName}
                      version={r.agentVersion}
                    />
                  </Td>
                  <Td>
                    <span
                      title={r.agentIntent ?? undefined}
                      className="block max-w-[280px] truncate text-foreground"
                    >
                      {r.agentIntent ?? <span className="text-subtle">—</span>}
                    </span>
                  </Td>
                  <Td>
                    <span
                      title={r.sqlRaw ?? r.sqlFingerprint ?? undefined}
                      className="block max-w-[420px] truncate font-mono text-xs text-foreground"
                    >
                      {r.sqlRaw ?? (
                        <span className="text-subtle">
                          {r.sqlFingerprint ?? "—"}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-right font-mono text-[11px] text-subtle">
                    {formatDuration(r.execMs)}
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

function AgentCell({
  name,
  version,
}: {
  name: string | null;
  version: string | null;
}) {
  if (!name) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-[3px] border border-border bg-secondary px-1.5 py-px font-mono text-[10px] text-foreground">
      <span>{name}</span>
      {version && (
        <span className="text-[9px] text-subtle">v{version}</span>
      )}
    </span>
  );
}

function formatDuration(execMs: number | null): React.ReactNode {
  if (execMs == null) return <span className="text-subtle">—</span>;
  if (execMs < 1) return "<1 ms";
  if (execMs < 1000) return `${Math.round(execMs)} ms`;
  return `${(execMs / 1000).toFixed(2)} s`;
}

function Th({
  children,
  width,
  align,
}: {
  children: React.ReactNode;
  width?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      style={width ? { width } : undefined}
      className={cn(
        "border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-[0.02em] text-subtle",
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

function parseStatuses(raw: string | undefined): readonly QueryStatus[] {
  if (!raw) return [];
  const valid = new Set<string>(QUERY_STATUSES);
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is QueryStatus => valid.has(s));
}

function makeUrlBuilder(state: {
  selectedStatuses: readonly QueryStatus[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  search: string;
  cursor: string | undefined;
}) {
  return (overrides: {
    status?: readonly QueryStatus[];
    tenantId?: string | null;
    database?: string | null;
    cursor?: string | null;
  }): string => {
    const statuses =
      overrides.status !== undefined
        ? overrides.status
        : state.selectedStatuses;
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
    if (statuses.length > 0) usp.set("status", statuses.join(","));
    if (tenant) usp.set("tenant_id", tenant);
    if (database) usp.set("database", database);
    if (state.search) usp.set("q", state.search);
    if (cursor) usp.set("cursor", cursor);
    const q = usp.toString();
    return q ? `/audit?${q}` : "/audit";
  };
}
