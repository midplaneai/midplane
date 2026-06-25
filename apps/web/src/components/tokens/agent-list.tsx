import "server-only";

import { Badge } from "@/components/ui/badge";
import { CreateTokenModal } from "@/components/tokens/create-token-modal";
import type { CreateTokenAction } from "@/components/tokens/create-token-modal";
import {
  RevokeTokenButton,
  type RevokeTokenAction,
} from "@/components/tokens/revoke-token-button";
import { resolveUsers } from "@/lib/users";
import { formatRelativeLong } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentSummary } from "@/lib/tokens";

// The Connect pane's agent list. Shows EVERY connected agent on a project —
// interactive OAuth clients (Cursor, Claude, ChatGPT, …) AND headless URL/PAT
// tokens (CI, cron) — in one table, each with the databases it may reach and a
// revoke. The connect card (OAuthConnectGuide) lives above this and owns the
// "how to connect" instructions, so this component carries none of that.
//
// Revoke is identical for both kinds: it flips the underlying mcp_tokens row to
// status='revoked', and the proxy gates on status='active', so access stops on
// the next request (no grant cleanup needed — fail-closed).
//
// Status semantics (see DESIGN.md):
//   - active + expiring (<14 days)        → warn  "Expiring"
//   - active + stale-not-used (>30 days)  → warn  "Stale"
//   - active + healthy                    → allow "Active"
//   - revoked                             → deny  "Revoked"
//   - expired                             → deny  "Expired"
// OAuth agents never expire, so only active/stale/revoked apply to them.

const EXPIRING_SOON_DAYS = 14;
const STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function AgentList({
  projectId,
  agents,
  databases = [],
  createAction,
  revokeAction,
  tokenLimit,
  now = new Date(),
}: {
  projectId: string;
  agents: AgentSummary[];
  /** This project's databases, for the machine-token scope picker (P6.1). */
  databases?: Array<{ projectDatabaseId: string; name: string }>;
  createAction: CreateTokenAction;
  revokeAction: RevokeTokenAction;
  /** Set when the org is already at its (finite) token cap — the create modal
   *  opens to a limit panel (upgrade + revoke-to-free-a-slot) instead of the
   *  form. */
  tokenLimit?: { limit: number; plan: string; upgradeUrl: string };
  now?: Date;
}) {
  // Sort: active first, then expired/revoked. Within each, most-recently-
  // created first.
  const sorted = [...agents].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const creatorIds = Array.from(new Set(sorted.map((t) => t.createdByUserId)));
  const creators = await resolveUsers(creatorIds);

  const createButton = (
    <CreateTokenModal
      projectId={projectId}
      databases={databases}
      action={createAction}
      triggerLabel="Create machine token"
      limitReached={tokenLimit}
    />
  );

  // No agents yet → a lean empty state that points UP to the connect card
  // (the OAuth URL) rather than repeating the instructions, plus the
  // machine-token escape hatch for headless callers.
  if (sorted.length === 0) {
    return (
      <section
        id="agents"
        className="scroll-mt-16 space-y-4 rounded-lg border border-border bg-card p-6"
        data-testid="agent-list"
        data-state="empty"
      >
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            No agents connected yet
          </h2>
          <p className="text-sm text-muted-foreground">
            Point your agent at the URL above and sign in — it shows up here once
            it connects, with the databases you granted it. For CI or cron that
            can&apos;t sign in, create a machine token instead.
          </p>
        </div>
        {createButton}
      </section>
    );
  }

  return (
    <section
      id="agents"
      className="scroll-mt-16 space-y-3 rounded-lg border border-border bg-card p-6"
      data-testid="agent-list"
      data-state="populated"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            Connected agents
          </h2>
          <p className="text-xs text-muted-foreground">
            Every agent connected to this project and the databases it can
            reach. Revoke the moment a laptop or runner goes missing.
          </p>
        </div>
        {createButton}
      </header>

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
        {sorted.map((agent) => (
          <AgentRow
            key={agent.id}
            projectId={projectId}
            agent={agent}
            creatorLabel={
              creators.get(agent.createdByUserId)?.label ?? agent.createdByUserId
            }
            creatorResolved={creators.get(agent.createdByUserId)?.resolved ?? false}
            revokeAction={revokeAction}
            now={now}
          />
        ))}
      </ul>
    </section>
  );
}

function AgentRow({
  projectId,
  agent,
  creatorLabel,
  creatorResolved,
  revokeAction,
  now,
}: {
  projectId: string;
  agent: AgentSummary;
  creatorLabel: string;
  creatorResolved: boolean;
  revokeAction: RevokeTokenAction;
  now: Date;
}) {
  const view = deriveStatusView(agent, now);
  const isOauth = agent.kind === "oauth";
  // Identity line: OAuth clients have no user-issued prefix — show the client
  // suffix instead so two of the same client are still distinguishable.
  const identity = isOauth
    ? `oauth · …${agent.last4}`
    : `${agent.prefix}_…${agent.last4}`;
  return (
    <li
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
      data-testid="agent-row"
      data-agent-id={agent.id}
      data-agent-kind={agent.kind}
      data-status={view.kind}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {agent.name}
          </span>
          <Badge variant="default">{isOauth ? "OAuth" : "Token"}</Badge>
          <Badge variant={view.badgeVariant}>{view.badgeLabel}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-subtle">
          <span data-testid="agent-identity">{identity}</span>
          <span aria-hidden>·</span>
          <span className={cn(creatorResolved ? "text-subtle" : "italic")}>
            {isOauth ? "authorized by" : "created by"} {creatorLabel}
          </span>
          <span aria-hidden>·</span>
          <span>{view.timingLine}</span>
        </div>
        <ScopeLine kind={agent.kind} scope={agent.scope} />
        <div className="font-mono text-[11px] text-subtle">
          {view.lastUsedLine}
        </div>
      </div>
      {agent.status === "active" ? (
        <div className="shrink-0">
          <RevokeTokenButton
            projectId={projectId}
            tokenId={agent.id}
            tokenName={agent.name}
            action={revokeAction}
          />
        </div>
      ) : (
        <span className="shrink-0 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
          (no actions)
        </span>
      )}
    </li>
  );
}

// The databases an agent may reach. An empty grant set means different things by
// kind: for an OAuth agent it was approved with no databases (cloud denies it,
// 403); for a URL/PAT token it's unscoped = full project access (the legacy /
// API-token default and the self-host owner default).
function ScopeLine({
  kind,
  scope,
}: {
  kind: AgentSummary["kind"];
  scope: AgentSummary["scope"];
}) {
  if (scope.length === 0) {
    return kind === "oauth" ? (
      <div className="text-[11px] text-subtle">no database access</div>
    ) : (
      <div className="text-[11px] text-[hsl(var(--warn))]">
        full project access
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {scope.map((s) => (
        <span
          key={s.database}
          className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
        >
          <span className="text-foreground">{s.database}</span>
          <span aria-hidden className="text-subtle">·</span>
          <span
            className={
              s.access === "write"
                ? "text-[hsl(var(--warn))]"
                : "text-[hsl(var(--allow))]"
            }
          >
            {s.access}
          </span>
        </span>
      ))}
    </div>
  );
}

interface StatusView {
  kind: "active" | "expiring" | "stale" | "revoked" | "expired";
  badgeVariant: "allow" | "warn" | "deny";
  badgeLabel: string;
  timingLine: string;
  lastUsedLine: string;
}

// Works on any row carrying the token lifecycle fields — both URL tokens and
// OAuth attribution rows have them (OAuth rows always have expiresAt = null).
function deriveStatusView(
  agent: Pick<
    AgentSummary,
    "status" | "expiresAt" | "lastUsedAt" | "revokedAt"
  >,
  now: Date,
): StatusView {
  const lastUsedLine = formatLastUsed(agent.lastUsedAt, now);

  if (agent.status === "revoked") {
    const revokedAt = agent.revokedAt ?? now;
    return {
      kind: "revoked",
      badgeVariant: "deny",
      badgeLabel: "Revoked",
      timingLine: `revoked ${formatRelativeLong(revokedAt, now)}`,
      lastUsedLine,
    };
  }
  if (agent.status === "expired") {
    const expiredAt = agent.expiresAt ?? agent.revokedAt ?? now;
    return {
      kind: "expired",
      badgeVariant: "deny",
      badgeLabel: "Expired",
      timingLine: `expired ${formatRelativeLong(expiredAt, now)}`,
      lastUsedLine,
    };
  }
  // Active branch. Expiring (more actionable) before stale.
  if (agent.expiresAt) {
    const daysUntilExpiry = Math.floor(
      (agent.expiresAt.getTime() - now.getTime()) / MS_PER_DAY,
    );
    if (daysUntilExpiry < EXPIRING_SOON_DAYS) {
      return {
        kind: "expiring",
        badgeVariant: "warn",
        badgeLabel: "Expiring",
        timingLine: formatRemaining(daysUntilExpiry),
        lastUsedLine,
      };
    }
    if (isStale(agent.lastUsedAt, now)) {
      return {
        kind: "stale",
        badgeVariant: "warn",
        badgeLabel: "Stale",
        timingLine: formatRemaining(daysUntilExpiry),
        lastUsedLine,
      };
    }
    return {
      kind: "active",
      badgeVariant: "allow",
      badgeLabel: "Active",
      timingLine: formatRemaining(daysUntilExpiry),
      lastUsedLine,
    };
  }
  // No expiry — OAuth agents and "never expires" tokens. Still surface stale.
  if (isStale(agent.lastUsedAt, now)) {
    return {
      kind: "stale",
      badgeVariant: "warn",
      badgeLabel: "Stale",
      timingLine: "no expiry",
      lastUsedLine,
    };
  }
  return {
    kind: "active",
    badgeVariant: "allow",
    badgeLabel: "Active",
    timingLine: "no expiry",
    lastUsedLine,
  };
}

function isStale(lastUsedAt: Date | null, now: Date): boolean {
  if (lastUsedAt === null) return false;
  return now.getTime() - lastUsedAt.getTime() > STALE_DAYS * MS_PER_DAY;
}

function formatRemaining(days: number): string {
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  if (days === 1) return "1 day remaining";
  return `${days} days remaining`;
}

function formatLastUsed(lastUsedAt: Date | null, now: Date): string {
  if (!lastUsedAt) return "Last used: (never used)";
  return `Last used: ${formatRelativeLong(lastUsedAt, now)}`;
}
