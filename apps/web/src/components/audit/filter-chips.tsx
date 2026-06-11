import { X } from "lucide-react";
import Link from "next/link";

import { AuditSearch } from "@/components/audit/audit-search";
import { FacetedFilter } from "@/components/audit/faceted-filter";
import { cn } from "@/lib/utils";
import {
  EVENT_STATUSES,
  QUERY_OUTCOME_STATUSES,
  type QueryStatus,
  type TokenOption,
} from "@/lib/audit";
// Type-only import — erased at compile time, so it doesn't pull the
// postgres driver in @/lib/connections into this (server) component bundle.
import { type ConnectionOption } from "@/lib/connections";

interface BuildUrlOverrides {
  status?: readonly QueryStatus[];
  tenantId?: string | null;
  database?: string | null;
  agentName?: string | null;
  tokenId?: string | null;
  connectionId?: string | null;
  search?: string | null;
  cursor?: string | null;
}

interface FilterChipsProps {
  selectedStatuses: readonly QueryStatus[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  selectedAgent: string | null;
  selectedToken: string | null;
  selectedConnection: string | null;
  tenants: readonly string[];
  databases: readonly string[];
  agents: readonly string[];
  tokens: readonly TokenOption[];
  connections: readonly ConnectionOption[];
  counts: Record<QueryStatus, number>;
  search: string;
  buildUrl: (overrides: BuildUrlOverrides) => string;
}

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1 text-xs transition-colors";
const CHIP_INACTIVE =
  "border-border bg-secondary text-muted-foreground hover:border-border-strong hover:text-foreground";
const CHIP_ACTIVE = "border-border-strong bg-popover text-foreground";
const CHIP_LABEL =
  "font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle";

// Short labels for the chips. Differ from StatusBadge labels because the
// chip strip is laid out horizontally and benefits from compact text;
// the badge is in-table where the longer label has room.
const CHIP_LABELS: Record<QueryStatus, string> = {
  ALLOWED: "Allowed",
  DENIED: "Denied",
  FAILED: "Failed",
  STUCK: "Stuck",
  PENDING: "Pending",
  POLICY_RELOAD: "Policy reload",
  TOKEN_CREATED: "Token created",
  TOKEN_REVOKED: "Token revoked",
};

// Dot color per status — mirrors StatusBadge's VARIANT_MAP so the lens chips
// and the in-table badges read as one vocabulary (allow green, deny red,
// staleness/credential amber, operator events brand blue, pending neutral).
const STATUS_DOT: Record<QueryStatus, string> = {
  ALLOWED: "bg-[hsl(var(--allow))]",
  DENIED: "bg-[hsl(var(--deny))]",
  FAILED: "bg-[hsl(var(--deny))]",
  STUCK: "bg-[hsl(var(--warn))]",
  PENDING: "bg-[hsl(var(--muted-foreground))]",
  POLICY_RELOAD: "bg-[hsl(var(--brand))]",
  TOKEN_CREATED: "bg-[hsl(var(--brand))]",
  TOKEN_REVOKED: "bg-[hsl(var(--warn))]",
};

export function FilterChips({
  selectedStatuses,
  selectedTenant,
  selectedDatabase,
  selectedAgent,
  selectedToken,
  selectedConnection,
  tenants,
  databases,
  agents,
  tokens,
  connections,
  counts,
  search,
  buildUrl,
}: FilterChipsProps) {
  const allStatusesActive = selectedStatuses.length === 0;
  const selectedTokenLabel =
    tokens.find((t) => t.id === selectedToken)?.label ?? selectedToken;
  const selectedConnectionLabel =
    connections.find((c) => c.id === selectedConnection)?.label ??
    selectedConnection;

  const activeCount =
    selectedStatuses.length +
    (selectedTenant ? 1 : 0) +
    (selectedDatabase ? 1 : 0) +
    (selectedAgent ? 1 : 0) +
    (selectedToken ? 1 : 0) +
    (selectedConnection ? 1 : 0) +
    (search ? 1 : 0);

  return (
    <div className="mb-3 space-y-2.5 border-b border-border pb-3">
      {/* Row 1 — search + entity facets ("what / where"). Open-ended sets
          (tenant, database, agent, token) live behind searchable dropdowns so
          the bar stays one line no matter how many values exist. */}
      <div className="flex flex-wrap items-center gap-2">
        <AuditSearch initialValue={search} className="w-full sm:w-[300px]" />
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          {tenants.length > 0 && (
            <FacetedFilter
              label="tenant"
              allHref={buildUrl({ tenantId: null, cursor: null })}
              selectedValue={selectedTenant}
              selectedLabel={selectedTenant}
              options={tenants.map((t) => ({
                value: t,
                label: t,
                href: buildUrl({
                  tenantId: selectedTenant === t ? null : t,
                  cursor: null,
                }),
              }))}
            />
          )}
          {databases.length > 0 && (
            <FacetedFilter
              label="database"
              allHref={buildUrl({ database: null, cursor: null })}
              selectedValue={selectedDatabase}
              selectedLabel={selectedDatabase}
              options={databases.map((d) => ({
                value: d,
                label: d,
                href: buildUrl({
                  database: selectedDatabase === d ? null : d,
                  cursor: null,
                }),
              }))}
            />
          )}
          {agents.length > 0 && (
            <FacetedFilter
              label="agent"
              allHref={buildUrl({ agentName: null, cursor: null })}
              selectedValue={selectedAgent}
              selectedLabel={selectedAgent}
              options={agents.map((a) => ({
                value: a,
                label: a,
                href: buildUrl({
                  agentName: selectedAgent === a ? null : a,
                  cursor: null,
                }),
              }))}
            />
          )}
          {tokens.length > 0 && (
            <FacetedFilter
              label="token"
              allHref={buildUrl({ tokenId: null, cursor: null })}
              selectedValue={selectedToken}
              selectedLabel={selectedTokenLabel}
              options={tokens.map((t) => ({
                value: t.id,
                label: t.label,
                href: buildUrl({
                  tokenId: selectedToken === t.id ? null : t.id,
                  cursor: null,
                }),
              }))}
            />
          )}
          {connections.length > 0 && (
            <FacetedFilter
              label="connection"
              allHref={buildUrl({ connectionId: null, cursor: null })}
              selectedValue={selectedConnection}
              selectedLabel={selectedConnectionLabel}
              options={connections.map((c) => ({
                value: c.id,
                label: c.label,
                href: buildUrl({
                  connectionId: selectedConnection === c.id ? null : c.id,
                  cursor: null,
                }),
              }))}
            />
          )}
        </div>
      </div>

      {/* Row 2 — status lens. The primary outcome axis stays inline: small
          fixed enum, semantic-colored, scannable. Zero-count states recede
          but stay clickable. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn(CHIP_LABEL, "mr-0.5")}>status</span>
        <Chip
          href={buildUrl({ status: [], cursor: null })}
          active={allStatusesActive}
        >
          <b className="font-medium">All</b>
        </Chip>
        {QUERY_OUTCOME_STATUSES.map((s) => (
          <StatusChip
            key={s}
            status={s}
            selectedStatuses={selectedStatuses}
            count={counts[s]}
            buildUrl={buildUrl}
          />
        ))}

        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span className={cn(CHIP_LABEL, "mr-0.5")}>events</span>
        {EVENT_STATUSES.map((s) => (
          <StatusChip
            key={s}
            status={s}
            selectedStatuses={selectedStatuses}
            count={counts[s]}
            buildUrl={buildUrl}
          />
        ))}
      </div>

      {/* Row 3 — active-filter summary. One place that shows everything
          currently narrowing the list; each pill removes itself, and
          "clear all" resets to the unfiltered view (window/time format kept). */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn(CHIP_LABEL, "mr-0.5")}>filters</span>
          {selectedStatuses.map((s) => (
            <RemovePill
              key={s}
              value={CHIP_LABELS[s]}
              href={buildUrl({
                status: selectedStatuses.filter((x) => x !== s),
                cursor: null,
              })}
              ariaLabel={`Remove ${CHIP_LABELS[s]} filter`}
            />
          ))}
          {selectedTenant && (
            <RemovePill
              prefix="tenant"
              value={selectedTenant}
              href={buildUrl({ tenantId: null, cursor: null })}
              ariaLabel="Remove tenant filter"
            />
          )}
          {selectedDatabase && (
            <RemovePill
              prefix="database"
              value={selectedDatabase}
              href={buildUrl({ database: null, cursor: null })}
              ariaLabel="Remove database filter"
            />
          )}
          {selectedAgent && (
            <RemovePill
              prefix="agent"
              value={selectedAgent}
              href={buildUrl({ agentName: null, cursor: null })}
              ariaLabel="Remove agent filter"
            />
          )}
          {selectedToken && (
            <RemovePill
              prefix="token"
              value={selectedTokenLabel ?? selectedToken}
              href={buildUrl({ tokenId: null, cursor: null })}
              ariaLabel="Remove token filter"
            />
          )}
          {selectedConnection && (
            <RemovePill
              prefix="connection"
              value={selectedConnectionLabel ?? selectedConnection}
              href={buildUrl({ connectionId: null, cursor: null })}
              ariaLabel="Remove connection filter"
            />
          )}
          {search && (
            <RemovePill
              prefix="search"
              value={`“${search}”`}
              href={buildUrl({ search: null, cursor: null })}
              ariaLabel="Remove search filter"
            />
          )}
          <Link
            href={buildUrl({
              status: [],
              tenantId: null,
              database: null,
              agentName: null,
              tokenId: null,
              connectionId: null,
              search: null,
              cursor: null,
            })}
            className="ml-0.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            clear all
          </Link>
        </div>
      )}
    </div>
  );
}

// A single toggle chip for one status. Toggling adds/removes the status
// from the multi-select set and resets the cursor (page 1) so the new
// filter starts at the newest matching row. Zero-count, unselected chips
// dim — they lead nowhere in this window — but stay clickable.
function StatusChip({
  status,
  selectedStatuses,
  count,
  buildUrl,
}: {
  status: QueryStatus;
  selectedStatuses: readonly QueryStatus[];
  count: number;
  buildUrl: FilterChipsProps["buildUrl"];
}) {
  const active = selectedStatuses.includes(status);
  const next = active
    ? selectedStatuses.filter((x) => x !== status)
    : [...selectedStatuses, status];
  const dim = count === 0 && !active;
  return (
    <Chip
      href={buildUrl({ status: next, cursor: null })}
      active={active}
      className={dim ? "opacity-45" : undefined}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])}
        aria-hidden
      />
      <b className="font-medium">{CHIP_LABELS[status]}</b>
      <Count active={active}>{count}</Count>
    </Chip>
  );
}

function Chip({
  href,
  active,
  className,
  children,
}: {
  href: string;
  active: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE, className)}
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

// One removable chip in the active-filters summary. The whole pill is the
// remove target (click anywhere to drop the filter), matching the convention
// in Sentry / Linear filter bars.
function RemovePill({
  prefix,
  value,
  href,
  ariaLabel,
}: {
  prefix?: string;
  value: string;
  href: string;
  ariaLabel: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      title={prefix ? `${prefix}: ${value}` : value}
      className="group inline-flex items-center gap-1.5 rounded-[3px] border border-border bg-secondary px-2 py-1 text-xs transition-colors hover:border-border-strong"
    >
      {prefix && (
        <span className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
          {prefix}
        </span>
      )}
      <span className="max-w-[180px] truncate font-mono font-medium text-foreground">
        {value}
      </span>
      <X
        className="h-3 w-3 shrink-0 text-subtle transition-colors group-hover:text-foreground"
        aria-hidden
      />
    </Link>
  );
}
