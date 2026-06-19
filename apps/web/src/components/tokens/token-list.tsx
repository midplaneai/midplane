import "server-only";

import { Badge } from "@/components/ui/badge";
import { ConnectAgentGuide } from "@/components/projects/connect-agent-guide";
import { CreateTokenModal } from "@/components/tokens/create-token-modal";
import type { CreateTokenAction } from "@/components/tokens/create-token-modal";
import {
  RevokeTokenButton,
  type RevokeTokenAction,
} from "@/components/tokens/revoke-token-button";
import { resolveUsers } from "@/lib/users";
import { formatRelativeLong } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TokenSummary } from "@/lib/tokens";

// Server-rendered token list panel. Data is loaded by the page component
// and passed in; this primitive owns presentation only — the [+ New
// token] modal, status visualization, and per-row revoke. The status
// derivation lives next to the render code so the badge color and the
// trailing copy ("12 days remaining" vs "Not used in 45 days" vs
// "revoked 3 days ago") stay in sync.
//
// Status semantics (see DESIGN.md + the design doc's Dashboard UX
// section):
//   - active + expiring (<14 days)        → warn  "Expires in 12 days"
//   - active + stale-not-used (>30 days)  → warn  "Not used in 45 days"
//   - active + healthy                    → allow "Active"
//   - revoked                             → deny  "Revoked 3 days ago"
//   - expired                             → deny  "Expired 1 day ago"
//
// If a token is both expiring AND stale, expiring takes precedence —
// it's more actionable (revoke + remint, vs. just remint when stale).

const EXPIRING_SOON_DAYS = 14;
const STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function TokenList({
  projectId,
  projectName,
  region,
  databases = [],
  tokens,
  createAction,
  revokeAction,
  tokenLimit,
  now = new Date(),
}: {
  projectId: string;
  projectName?: string | null;
  region?: string | null;
  /** This project's databases, for the token scope picker (P6.1). */
  databases?: Array<{ projectDatabaseId: string; name: string }>;
  tokens: TokenSummary[];
  createAction: CreateTokenAction;
  revokeAction: RevokeTokenAction;
  /** Set when the org is already at its (finite) token cap — the create
   *  modal opens to a limit panel (upgrade + revoke-to-free-a-slot) instead
   *  of the form. The cap is org-wide, so this is decided by the page from
   *  total usable-token usage, not this project's rows. */
  tokenLimit?: { limit: number; plan: string; upgradeUrl: string };
  now?: Date;
}) {
  // Sort: active first, then expired/revoked. Within each, most-recently-
  // created first — same shape the design doc's table mock uses.
  const sorted = [...tokens].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const creatorIds = Array.from(new Set(sorted.map((t) => t.createdByUserId)));
  const creators = await resolveUsers(creatorIds);

  // No agents yet → lead with the quickstart: teach that this project is
  // an MCP server, then a single prominent "Connect" CTA, with the setup
  // card as a preview so they see what they're about to wire up.
  if (sorted.length === 0) {
    return (
      <section
        id="tokens"
        className="scroll-mt-16 space-y-5 rounded-lg border border-border bg-card p-6"
        data-testid="token-list"
        data-state="empty"
      >
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            Connect your first agent
          </h2>
          <p className="text-sm text-muted-foreground">
            Point your agent at this project&apos;s{" "}
            <strong className="font-medium text-foreground">
              MCP server URL
            </strong>{" "}
            and sign in — no secret to copy. Every query it runs is proxied
            through your access policy. Headless callers (CI, cron) can mint a
            machine token instead.
          </p>
        </div>
        <ConnectAgentGuide projectName={projectName} region={region} />
        <CreateTokenModal
          projectId={projectId}
          projectName={projectName}
          region={region}
          databases={databases}
          action={createAction}
          triggerLabel="Create a machine token"
          limitReached={tokenLimit}
        />
      </section>
    );
  }

  return (
    <section
      id="tokens"
      className="scroll-mt-16 space-y-3 rounded-lg border border-border bg-card p-6"
      data-testid="token-list"
      data-state="populated"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            MCP server endpoints
          </h2>
          <p className="text-xs text-muted-foreground">
            Each row is a credentialed URL for one agent. Revoke the moment a
            laptop goes missing.
          </p>
        </div>
        <CreateTokenModal
          projectId={projectId}
          projectName={projectName}
          region={region}
          databases={databases}
          action={createAction}
          limitReached={tokenLimit}
        />
      </header>

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
        {sorted.map((token) => (
          <TokenRow
            key={token.id}
            projectId={projectId}
            token={token}
            creatorLabel={creators.get(token.createdByUserId)?.label ?? token.createdByUserId}
            creatorResolved={creators.get(token.createdByUserId)?.resolved ?? false}
            revokeAction={revokeAction}
            now={now}
          />
        ))}
      </ul>

      {/* Reference copy of the setup snippets. The live URL is show-once, so
          this carries a <token> placeholder; a real URL only appears in the
          connect modal's success panel. */}
      <details className="group rounded-md border border-border bg-background">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle hover:text-foreground">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
          how to connect an agent
        </summary>
        <div className="px-4 pb-4">
          <ConnectAgentGuide projectName={projectName} region={region} />
        </div>
      </details>
    </section>
  );
}

function TokenRow({
  projectId,
  token,
  creatorLabel,
  creatorResolved,
  revokeAction,
  now,
}: {
  projectId: string;
  token: TokenSummary;
  creatorLabel: string;
  creatorResolved: boolean;
  revokeAction: RevokeTokenAction;
  now: Date;
}) {
  const view = deriveStatusView(token, now);
  return (
    <li
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
      data-testid="token-row"
      data-token-id={token.id}
      data-status={view.kind}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {token.name}
          </span>
          <Badge variant={view.badgeVariant}>{view.badgeLabel}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-subtle">
          <span data-testid="token-prefix">{token.prefix}_…{token.last4}</span>
          <span aria-hidden>·</span>
          <span className={cn(creatorResolved ? "text-subtle" : "italic")}>
            created by {creatorLabel}
          </span>
          <span aria-hidden>·</span>
          <span>{view.timingLine}</span>
        </div>
        <div className="font-mono text-[11px] text-subtle">
          {view.lastUsedLine}
        </div>
      </div>
      {token.status === "active" ? (
        <div className="shrink-0">
          <RevokeTokenButton
            projectId={projectId}
            tokenId={token.id}
            tokenName={token.name}
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

interface StatusView {
  kind:
    | "active"
    | "expiring"
    | "stale"
    | "revoked"
    | "expired";
  badgeVariant: "allow" | "warn" | "deny";
  badgeLabel: string;
  timingLine: string;
  lastUsedLine: string;
}

function deriveStatusView(token: TokenSummary, now: Date): StatusView {
  const lastUsedLine = formatLastUsed(token.lastUsedAt, now);

  if (token.status === "revoked") {
    const revokedAt = token.revokedAt ?? now;
    return {
      kind: "revoked",
      badgeVariant: "deny",
      badgeLabel: "Revoked",
      timingLine: `revoked ${formatRelativeLong(revokedAt, now)}`,
      lastUsedLine,
    };
  }
  if (token.status === "expired") {
    const expiredAt = token.expiresAt ?? token.revokedAt ?? now;
    return {
      kind: "expired",
      badgeVariant: "deny",
      badgeLabel: "Expired",
      timingLine: `expired ${formatRelativeLong(expiredAt, now)}`,
      lastUsedLine,
    };
  }
  // Active branch. Check expiring before stale: expiring is more
  // actionable (the token will stop working soon; the customer needs to
  // remint), stale is informational (token still works, just unused).
  if (token.expiresAt) {
    const daysUntilExpiry = Math.floor(
      (token.expiresAt.getTime() - now.getTime()) / MS_PER_DAY,
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
    if (isStale(token.lastUsedAt, now)) {
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
  // No expiry — "never expires" tokens. Still surface stale-not-used.
  if (isStale(token.lastUsedAt, now)) {
    return {
      kind: "stale",
      badgeVariant: "warn",
      badgeLabel: "Stale",
      timingLine: "never expires",
      lastUsedLine,
    };
  }
  return {
    kind: "active",
    badgeVariant: "allow",
    badgeLabel: "Active",
    timingLine: "never expires",
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
