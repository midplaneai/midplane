import Link from "next/link";

import { cn } from "@/lib/utils";
import {
  EVENT_STATUSES,
  QUERY_OUTCOME_STATUSES,
  type AuditWindowKey,
  type QueryStatus,
  type TokenOption,
} from "@/lib/audit";

interface BuildUrlOverrides {
  status?: readonly QueryStatus[];
  tenantId?: string | null;
  database?: string | null;
  agentName?: string | null;
  tokenId?: string | null;
  cursor?: string | null;
}

interface FilterChipsProps {
  selectedStatuses: readonly QueryStatus[];
  selectedTenant: string | null;
  selectedDatabase: string | null;
  selectedAgent: string | null;
  selectedToken: string | null;
  tenants: readonly string[];
  databases: readonly string[];
  agents: readonly string[];
  tokens: readonly TokenOption[];
  counts: Record<QueryStatus, number>;
  search: string;
  /** Preserved across the search-form submit via hidden inputs. */
  windowKey: AuditWindowKey;
  timeFormat: "rel" | "abs";
  buildUrl: (overrides: BuildUrlOverrides) => string;
}

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors";
const CHIP_INACTIVE =
  "border-border bg-secondary text-muted-foreground hover:border-border-strong hover:text-foreground";
const CHIP_ACTIVE =
  "border-border-strong bg-popover text-foreground";
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

export function FilterChips({
  selectedStatuses,
  selectedTenant,
  selectedDatabase,
  selectedAgent,
  selectedToken,
  tenants,
  databases,
  agents,
  tokens,
  counts,
  search,
  windowKey,
  timeFormat,
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
      {QUERY_OUTCOME_STATUSES.map((s) => (
        <StatusChip
          key={s}
          status={s}
          selectedStatuses={selectedStatuses}
          count={counts[s]}
          buildUrl={buildUrl}
        />
      ))}

      <span className={cn(CHIP_LABEL, "ml-2 mr-1")}>Events</span>
      {EVENT_STATUSES.map((s) => (
        <StatusChip
          key={s}
          status={s}
          selectedStatuses={selectedStatuses}
          count={counts[s]}
          buildUrl={buildUrl}
        />
      ))}

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

      {agents.length > 0 && (
        <>
          <span className={cn(CHIP_LABEL, "ml-3 mr-1")}>Agent</span>
          <Chip
            href={buildUrl({ agentName: null, cursor: null })}
            active={selectedAgent === null}
          >
            <b className="font-medium">All</b>
            <Count active={selectedAgent === null}>{agents.length}</Count>
          </Chip>
          {agents.map((a) => (
            <Chip
              key={a}
              href={buildUrl({
                agentName: selectedAgent === a ? null : a,
                cursor: null,
              })}
              active={selectedAgent === a}
            >
              <b className="font-mono font-medium">{truncate(a, 18)}</b>
            </Chip>
          ))}
        </>
      )}

      {tokens.length > 0 && (
        <>
          <span className={cn(CHIP_LABEL, "ml-3 mr-1")}>Token</span>
          <Chip
            href={buildUrl({ tokenId: null, cursor: null })}
            active={selectedToken === null}
          >
            <b className="font-medium">All</b>
            <Count active={selectedToken === null}>{tokens.length}</Count>
          </Chip>
          {tokens.map((t) => (
            <Chip
              key={t.id}
              href={buildUrl({
                tokenId: selectedToken === t.id ? null : t.id,
                cursor: null,
              })}
              active={selectedToken === t.id}
            >
              <b className="font-mono font-medium">{truncate(t.label, 22)}</b>
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
        {selectedAgent && (
          <input type="hidden" name="agent" value={selectedAgent} />
        )}
        {selectedToken && (
          <input type="hidden" name="token" value={selectedToken} />
        )}
        <input type="hidden" name="window" value={windowKey} />
        {timeFormat === "abs" && (
          <input type="hidden" name="t" value="abs" />
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

// A single toggle chip for one status. Toggling adds/removes the status
// from the multi-select set and resets the cursor (page 1) so the new
// filter starts at the newest matching row.
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
  return (
    <Chip href={buildUrl({ status: next, cursor: null })} active={active}>
      <b className="font-medium">{CHIP_LABELS[status]}</b>
      <Count active={active}>{count}</Count>
    </Chip>
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
