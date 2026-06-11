import { Download } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FilterChips } from "@/components/audit/filter-chips";
import { RefreshButton } from "@/components/audit/refresh-button";
import { absoluteTime, relativeTime } from "@/components/audit/relative-time";
import { SqlCopyButton } from "@/components/audit/sql-copy-button";
import { SqlKindBadge } from "@/components/audit/sql-kind-badge";
import { StalenessSubtitle } from "@/components/audit/staleness-banner";
import { eventSummary, StatusBadge } from "@/components/audit/status-badge";
import { VolumeSparkline } from "@/components/audit/volume-sparkline";
import { WindowSelect } from "@/components/audit/window-select";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  auditWindowSince,
  countByStatus,
  eventVolumeByHour,
  isEventStatus,
  listAgents,
  listAuditQueries,
  listDatabases,
  listTenantIds,
  listTokenOptions,
  parseAuditWindow,
  QUERY_STATUSES,
  readStaleness,
  resolveAuditWindow,
  type AuditWindow,
  type AuditWindowKey,
  type QueryStatus,
} from "@/lib/audit";
import { listConnectionOptions } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { resolvePlan } from "@/lib/plan";

const PAGE_SIZE = 50;

type TimeFormat = "rel" | "abs";

// Nominal lookback for each window key, before retention clamping. Used only
// to detect whether the resolved window was actually clamped.
const NOMINAL_WINDOW_HOURS: Record<AuditWindowKey, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

// Label the EFFECTIVE (post-clamp) window, not the requested key — when
// retention caps a 30d request to 7 days, the chart must say "last 7 days",
// not "last 30 days". Flag the clamp so the shortfall reads as a plan limit,
// not a bug.
function describeWindow(windowKey: AuditWindowKey, window: AuditWindow): string {
  const base =
    window.bucket === "hour"
      ? "last 24h"
      : `last ${Math.round(window.hours / 24)} days`;
  const clamped = window.hours < NOMINAL_WINDOW_HOURS[windowKey];
  return clamped ? `${base} (plan max)` : base;
}

interface PageProps {
  searchParams: Promise<{
    status?: string;
    tenant_id?: string;
    database?: string;
    agent?: string;
    token?: string;
    connection?: string;
    q?: string;
    window?: string;
    t?: string;
    cursor?: string;
  }>;
}

export default async function AuditListPage({ searchParams }: PageProps) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  // Plan retention window (Free 7d, Pro/Team 30d). Threaded into every audit
  // read so the list, chips, counts, and chart all honor the same horizon.
  const { caps } = await resolvePlan();
  const retentionDays = caps.auditRetentionDays;

  const params = await searchParams;
  const selectedStatuses = parseStatuses(params.status);
  const selectedTenant = params.tenant_id?.trim() || null;
  const selectedDatabase = params.database?.trim() || null;
  const selectedAgent = params.agent?.trim() || null;
  const selectedToken = params.token?.trim() || null;
  const selectedConnection = params.connection?.trim() || null;
  const search = params.q?.trim() ?? "";
  const cursor = params.cursor?.trim() || undefined;
  const timeFormat: TimeFormat = params.t === "abs" ? "abs" : "rel";

  // Resolve the chosen time window, clamped to the plan retention horizon.
  // windowSince is a SINGLE bucket-aligned instant (computed once off `now`)
  // fed to every read AND the chart, so the sparkline total and the table
  // filter the exact same range — no first-partial-day drift between them.
  const now = new Date();
  const windowKey = parseAuditWindow(params.window);
  const window = resolveAuditWindow(windowKey, retentionDays);
  const windowSince = auditWindowSince(window, now);

  const [
    list,
    tenants,
    databases,
    agents,
    tokens,
    connections,
    counts,
    volume,
    staleness,
  ] = await Promise.all([
    listAuditQueries(customer.id, {
      region: customer.region,
      statuses: selectedStatuses,
      tenantId: selectedTenant ?? undefined,
      database: selectedDatabase ?? undefined,
      agentName: selectedAgent ?? undefined,
      tokenId: selectedToken ?? undefined,
      connectionId: selectedConnection ?? undefined,
      search,
      cursor,
      pageSize: PAGE_SIZE,
      retentionDays,
      windowSince,
    }),
    listTenantIds(customer.id, customer.region, retentionDays, windowSince),
    listDatabases(customer.id, customer.region, retentionDays, windowSince),
    listAgents(customer.id, customer.region, retentionDays, windowSince),
    listTokenOptions(customer.id, customer.region, retentionDays, windowSince),
    listConnectionOptions(customer),
    countByStatus(
      customer.id,
      customer.region,
      () => now,
      retentionDays,
      windowSince,
      selectedConnection ?? undefined,
    ),
    eventVolumeByHour(customer.id, customer.region, {
      tenantId: selectedTenant ?? undefined,
      database: selectedDatabase ?? undefined,
      agentName: selectedAgent ?? undefined,
      tokenId: selectedToken ?? undefined,
      connectionId: selectedConnection ?? undefined,
      search,
      retentionDays,
      bucket: window.bucket,
      bucketCount: window.bucketCount,
      windowSince,
      now: () => now,
    }),
    readStaleness(customer.id, customer.region),
  ]);

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const hasFilters =
    selectedStatuses.length > 0 ||
    selectedTenant !== null ||
    selectedDatabase !== null ||
    selectedAgent !== null ||
    selectedToken !== null ||
    selectedConnection !== null ||
    search.length > 0;

  const buildUrl = makeUrlBuilder({
    selectedStatuses,
    selectedTenant,
    selectedDatabase,
    selectedAgent,
    selectedToken,
    selectedConnection,
    search,
    windowKey,
    timeFormat,
    cursor,
  });
  // Export carries the active filters + window (but not the cursor — export
  // is the whole filtered set, not one page). Same query string, /export path.
  const exportHref = buildUrl({ cursor: null }).replace(
    /^\/audit/,
    "/audit/export",
  );

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Audit log" }]} />
      </Topbar>
      <PageContainer>
        <PageHeader title="Audit log" />
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <StalenessSubtitle read={staleness} totalCount={totalCount} />
          <div className="flex items-center gap-2">
            <WindowSelect
              selected={windowKey}
              hrefFor={(w) => buildUrl({ window: w, cursor: null })}
            />
            <a
              href={exportHref}
              download
              aria-label="Export the filtered audit log as CSV"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-secondary px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors",
                "hover:border-border-strong hover:text-foreground",
              )}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export
            </a>
            <RefreshButton />
          </div>
        </div>

        <VolumeSparkline
          buckets={volume}
          granularity={window.bucket}
          windowLabel={describeWindow(windowKey, window)}
        />

        <FilterChips
          selectedStatuses={selectedStatuses}
          selectedTenant={selectedTenant}
          selectedDatabase={selectedDatabase}
          selectedAgent={selectedAgent}
          selectedToken={selectedToken}
          selectedConnection={selectedConnection}
          tenants={tenants}
          databases={databases}
          agents={agents}
          tokens={tokens}
          connections={connections}
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
                <th
                  style={{ width: timeFormat === "abs" ? "16%" : "11%" }}
                  className="border-b border-border px-3 py-2 text-left"
                >
                  <Link
                    href={buildUrl({
                      timeFormat: timeFormat === "abs" ? "rel" : "abs",
                    })}
                    aria-label={`Show ${timeFormat === "abs" ? "relative" : "absolute"} times`}
                    className="inline-flex items-baseline gap-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground"
                  >
                    time
                    <span className="text-[9px] opacity-70">
                      · {timeFormat === "abs" ? "utc" : "ago"}
                    </span>
                  </Link>
                </th>
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
                  className={cn(
                    "group/row relative border-b border-card transition-colors",
                    // Deny rows carry a faint deny tint (mirrors the landing's
                    // .at-table .tr.deny treatment) so policy failures stand
                    // out at a glance.
                    r.status === "DENIED"
                      ? "bg-[hsl(var(--deny)/0.06)] hover:bg-[hsl(var(--deny)/0.1)]"
                      : "hover:bg-card",
                  )}
                >
                  <Td className="whitespace-nowrap font-mono text-[11px] text-subtle">
                    <Link
                      href={`/audit/${r.headEventId}`}
                      aria-label={`Open audit event ${r.queryId ?? r.attemptedEventId}`}
                      className="before:absolute before:inset-0 before:z-0 before:content-['']"
                    >
                      {timeFormat === "abs"
                        ? absoluteTime(r.startedAt)
                        : relativeTime(r.startedAt)}
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
                    {isEventStatus(r.status) ? (
                      <span
                        className="block max-w-[420px] truncate text-foreground"
                        data-testid="audit-policy-summary"
                      >
                        {eventSummary(r.status, r.policyPayload)}
                      </span>
                    ) : (
                      <div className="flex max-w-[420px] items-center gap-2">
                        <SqlKindBadge sql={r.sqlRaw} />
                        <span
                          title={r.sqlRaw ?? r.sqlFingerprint ?? undefined}
                          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                        >
                          {r.sqlRaw ?? (
                            <span className="text-subtle">
                              {r.sqlFingerprint ?? "—"}
                            </span>
                          )}
                        </span>
                        {r.sqlRaw && <SqlCopyButton sql={r.sqlRaw} />}
                      </div>
                    )}
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
  selectedAgent: string | null;
  selectedToken: string | null;
  selectedConnection: string | null;
  search: string;
  windowKey: AuditWindowKey;
  timeFormat: TimeFormat;
  cursor: string | undefined;
}) {
  return (overrides: {
    status?: readonly QueryStatus[];
    tenantId?: string | null;
    database?: string | null;
    agentName?: string | null;
    tokenId?: string | null;
    connectionId?: string | null;
    search?: string | null;
    window?: AuditWindowKey;
    timeFormat?: TimeFormat;
    cursor?: string | null;
  }): string => {
    const pick = <T,>(o: T | undefined, fallback: T): T =>
      o !== undefined ? o : fallback;
    const statuses = pick(overrides.status, state.selectedStatuses);
    const tenant = pick(overrides.tenantId, state.selectedTenant);
    const database = pick(overrides.database, state.selectedDatabase);
    const agent = pick(overrides.agentName, state.selectedAgent);
    const token = pick(overrides.tokenId, state.selectedToken);
    const connection = pick(overrides.connectionId, state.selectedConnection);
    const searchVal = pick(overrides.search, state.search);
    const windowKey = pick(overrides.window, state.windowKey);
    const timeFormat = pick(overrides.timeFormat, state.timeFormat);
    const cursor = pick(overrides.cursor, state.cursor);
    const usp = new URLSearchParams();
    if (statuses.length > 0) usp.set("status", statuses.join(","));
    if (tenant) usp.set("tenant_id", tenant);
    if (database) usp.set("database", database);
    if (agent) usp.set("agent", agent);
    if (token) usp.set("token", token);
    if (connection) usp.set("connection", connection);
    if (searchVal) usp.set("q", searchVal);
    // Window is a normal param; omit the 24h default to keep URLs clean.
    if (windowKey !== "24h") usp.set("window", windowKey);
    if (timeFormat === "abs") usp.set("t", "abs");
    if (cursor) usp.set("cursor", cursor);
    const q = usp.toString();
    return q ? `/audit?${q}` : "/audit";
  };
}
