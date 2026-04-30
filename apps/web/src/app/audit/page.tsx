import Link from "next/link";
import { redirect } from "next/navigation";

import { EventBadge } from "@/components/audit/event-badge";
import { FilterChips } from "@/components/audit/filter-chips";
import { relativeTime } from "@/components/audit/relative-time";
import {
  StalenessBanner,
  StalenessSubtitle,
} from "@/components/audit/staleness-banner";
import {
  countByEventType,
  EVENT_TYPES,
  listAuditEvents,
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
  const search = params.q?.trim() ?? "";
  const cursor = params.cursor?.trim() || undefined;

  const [list, tenants, counts, staleness] = await Promise.all([
    listAuditEvents(customer.id, {
      region: customer.region,
      eventTypes: selectedTypes,
      tenantId: selectedTenant ?? undefined,
      search,
      cursor,
      pageSize: PAGE_SIZE,
    }),
    listTenantIds(customer.id, customer.region),
    countByEventType(customer.id, customer.region),
    readStaleness(customer.id, customer.region),
  ]);

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const hasFilters =
    selectedTypes.length > 0 || selectedTenant !== null || search.length > 0;

  const buildUrl = makeUrlBuilder({
    selectedTypes,
    selectedTenant,
    search,
    cursor,
  });

  return (
    <>
      <header className="md-topbar">
        <div className="md-breadcrumb">
          <b>{customer.email}</b>
          <span className="md-breadcrumb-sep">/</span>Audit log
        </div>
      </header>
      <div className="md-content">
        <div className="md-page-header">
          <h1 className="md-page-title">Audit log</h1>
        </div>
        <StalenessSubtitle read={staleness} totalCount={totalCount} />
        <StalenessBanner read={staleness} />

        <FilterChips
          selectedTypes={selectedTypes}
          selectedTenant={selectedTenant}
          tenants={tenants}
          counts={counts}
          search={search}
          buildUrl={buildUrl}
        />

        {list.rows.length === 0 ? (
          <EmptyState hasFilters={hasFilters} />
        ) : (
          <table className="md-table" data-testid="audit-table">
            <thead>
              <tr>
                <th style={{ width: "13%" }}>Time</th>
                <th style={{ width: "13%" }}>Event</th>
                <th style={{ width: "16%" }}>Agent</th>
                <th style={{ width: "16%" }}>Query ID</th>
                <th>SQL fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr
                  key={r.id}
                  className="md-row"
                  data-testid="audit-row"
                  data-event-type={r.eventType}
                  data-tenant-id={r.tenantId}
                >
                  <td className="md-ts">
                    <Link href={`/audit/${r.id}`}>{relativeTime(r.ts)}</Link>
                  </td>
                  <td>
                    <Link href={`/audit/${r.id}`}>
                      <EventBadge eventType={r.eventType} />
                    </Link>
                  </td>
                  <td>
                    <Link href={`/audit/${r.id}`}>
                      {r.agentIdentity ? (
                        <span className="md-agent-pill">
                          {r.agentIdentity}
                        </span>
                      ) : (
                        <span className="md-muted">—</span>
                      )}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/audit/${r.id}`} className="md-query-id">
                      {truncate(r.queryId, 16)}
                    </Link>
                  </td>
                  <td>
                    <Link
                      href={`/audit/${r.id}`}
                      className="md-fingerprint"
                      title={r.sqlFingerprint ?? undefined}
                    >
                      {r.sqlFingerprint ?? (
                        <span className="md-muted">—</span>
                      )}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {(list.rows.length > 0 || cursor) && (
          <div className="md-footer">
            <span>
              Showing{" "}
              <span className="mono">{list.rows.length.toLocaleString()}</span>
              {totalCount > 0 && (
                <>
                  {" "}
                  of <span className="mono">{totalCount.toLocaleString()}</span>
                </>
              )}
            </span>
            <div className="md-pagination">
              <Link
                href={buildUrl({ cursor: null })}
                className={`md-page-btn${cursor ? "" : " disabled"}`}
                aria-disabled={!cursor}
              >
                ← Newest
              </Link>
              <Link
                href={
                  list.nextCursor
                    ? buildUrl({ cursor: list.nextCursor })
                    : "#"
                }
                className={`md-page-btn${list.nextCursor ? "" : " disabled"}`}
                aria-disabled={!list.nextCursor}
              >
                Older →
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  if (hasFilters) {
    return (
      <div className="md-empty">
        <div className="md-empty-title">No matching audit rows</div>
        <div>Try clearing a filter, or widen the search term.</div>
      </div>
    );
  }
  return (
    <div className="md-empty">
      <div className="md-empty-title">No queries yet.</div>
      <div>
        Once you wire up your agent, queries will appear here.{" "}
        <Link
          href="/dashboard"
          style={{ color: "var(--accent)", textDecoration: "underline" }}
        >
          Connect a database →
        </Link>
      </div>
      <pre>{`agent ─▶ MCP token ─▶ midplane engine ─▶ your Postgres
                              │
                              └─▶ audit_events ──▶ this dashboard`}</pre>
    </div>
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
  search: string;
  cursor: string | undefined;
}) {
  return (overrides: {
    eventType?: readonly EventType[];
    tenantId?: string | null;
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
    const cursor =
      overrides.cursor !== undefined ? overrides.cursor : state.cursor;
    const usp = new URLSearchParams();
    if (types.length > 0) usp.set("event_type", types.join(","));
    if (tenant) usp.set("tenant_id", tenant);
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
