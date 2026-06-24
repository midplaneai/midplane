import { cn } from "@/lib/utils";

// Current-plan consumption for the /billing page: how much of each capped
// resource the org is using right now. Server-rendered, presentational — the
// caller resolves the numbers (getPlanUsage + countOrgSeats) and the active
// plan's caps, this just draws the bars.
//
// `cap` may be Infinity (Team / self-host): an unlimited resource shows the
// count with no denominator and no bar — a full bar would imply a ceiling that
// isn't there. At/over a finite cap the row flips to --warn (the closest
// semantic for "at capacity"; plan limits aren't query-lifecycle, so this is the
// one borrowed use). The numbers are advisory, matching the pre-flight reads
// that gate creates/invites — the locked DB checks are the real enforcers.

export interface UsageRow {
  label: string;
  used: number;
  cap: number;
}

function MeteredRow({ label, used, cap }: UsageRow) {
  const unlimited = !Number.isFinite(cap);
  const atCap = !unlimited && used >= cap;
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
          {label}
        </span>
        <span
          className={cn(
            "font-mono text-[12px] tabular-nums",
            atCap ? "text-[hsl(var(--warn))]" : "text-foreground",
          )}
        >
          {used}
          <span className="text-subtle">
            {" / "}
            {unlimited ? "unlimited" : cap}
          </span>
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-1 w-full bg-border" aria-hidden>
          <div
            className={cn(
              "h-full",
              atCap ? "bg-[hsl(var(--warn))]" : "bg-foreground",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function UsageMeter({
  rows,
  retentionDays,
}: {
  rows: UsageRow[];
  retentionDays: number;
}) {
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <MeteredRow key={r.label} {...r} />
      ))}
      <div className="flex items-baseline justify-between gap-3 border-t border-card pt-3">
        <span className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
          audit retention
        </span>
        <span className="font-mono text-[12px] tabular-nums text-foreground">
          {Number.isFinite(retentionDays) ? `${retentionDays} days` : "unlimited"}
        </span>
      </div>
    </div>
  );
}
