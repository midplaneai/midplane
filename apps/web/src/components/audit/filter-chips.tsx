import { EVENT_TYPES, type EventType } from "@/lib/audit";

interface FilterChipsProps {
  selectedTypes: readonly EventType[];
  selectedTenant: string | null;
  tenants: readonly string[];
  counts: Record<EventType, number>;
  search: string;
  buildUrl: (overrides: {
    eventType?: readonly EventType[];
    tenantId?: string | null;
    cursor?: string | null;
  }) => string;
}

// All chips render as plain anchors that mutate the URL. Toggle semantics:
// clicking an event_type chip flips it on/off in the comma-list; clicking
// "All" clears the list. Tenant is single-select (mockup convention) so
// each tenant chip sets to that tenant; "All" clears.
//
// The search box is its own GET form below the chips so a bare ENTER
// submits without JS.

export function FilterChips({
  selectedTypes,
  selectedTenant,
  tenants,
  counts,
  search,
  buildUrl,
}: FilterChipsProps) {
  const allTypesActive = selectedTypes.length === 0;

  return (
    <div className="md-filters">
      <span className="md-nav-label" style={{ padding: 0, marginRight: 4 }}>
        Event
      </span>
      <a
        href={buildUrl({ eventType: [], cursor: null })}
        className={`md-filter${allTypesActive ? " active" : ""}`}
      >
        <b>All</b>
      </a>
      {EVENT_TYPES.map((t) => {
        const active = selectedTypes.includes(t);
        const next = active
          ? selectedTypes.filter((x) => x !== t)
          : [...selectedTypes, t];
        return (
          <a
            key={t}
            href={buildUrl({ eventType: next, cursor: null })}
            className={`md-filter${active ? " active" : ""}`}
          >
            <b>{t.charAt(0) + t.slice(1).toLowerCase()}</b>
            <span className="md-filter-count">{counts[t]}</span>
          </a>
        );
      })}

      {tenants.length > 0 && (
        <>
          <span
            className="md-nav-label"
            style={{ padding: 0, marginLeft: 12, marginRight: 4 }}
          >
            Tenant
          </span>
          <a
            href={buildUrl({ tenantId: null, cursor: null })}
            className={`md-filter${selectedTenant === null ? " active" : ""}`}
          >
            <b>All</b>
            <span className="md-filter-count">{tenants.length}</span>
          </a>
          {tenants.map((t) => (
            <a
              key={t}
              href={buildUrl({
                tenantId: selectedTenant === t ? null : t,
                cursor: null,
              })}
              className={`md-filter${selectedTenant === t ? " active" : ""}`}
            >
              <b className="mono">{truncate(t, 18)}</b>
            </a>
          ))}
        </>
      )}

      <form action="/audit" method="get" style={{ marginLeft: "auto" }}>
        {/* Preserve the active filters across a search submission. */}
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
        <input
          name="q"
          defaultValue={search}
          className="md-filter-search"
          placeholder="Search query_id or sql_fingerprint…"
          aria-label="Search audit rows"
        />
      </form>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
