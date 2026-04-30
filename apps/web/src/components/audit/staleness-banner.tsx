import type { StalenessRead } from "@/lib/audit";

const STALE_WARN_MS = 30_000;

// Three states per the design doc:
//   < 30s          → muted "as-of Ns ago" subtitle, no banner.
//   30s – 5 min    → amber banner: "Audit data is N seconds stale (indexer
//                    paused). Hot path unaffected."
//   > 5 min        → same wording. The dashboard intentionally still renders
//                    rows — graceful degradation, not block.
//
// Null staleMs (no cursor rows yet) renders nothing here; the table's empty
// state carries that case. We never block render on this component.

export function StalenessBanner({ read }: { read: StalenessRead }) {
  if (read.staleMs === null) return null;
  if (read.staleMs < STALE_WARN_MS) return null;

  return (
    <div
      role="status"
      data-testid="staleness-banner"
      className="mb-[18px] flex items-center gap-2.5 rounded-lg border border-[hsl(var(--warn)/0.2)] bg-[hsl(var(--warn)/0.08)] px-3.5 py-2.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[hsl(var(--warn))]"
      />
      <span>
        <b className="font-medium text-foreground">
          Audit data is {formatDuration(read.staleMs)} stale.
        </b>{" "}
        Indexer paused (recovering). Hot path unaffected.
      </span>
    </div>
  );
}

export function StalenessSubtitle({
  read,
  totalCount,
}: {
  read: StalenessRead;
  totalCount: number;
}) {
  if (read.staleMs === null) {
    return (
      <div className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{totalCount.toLocaleString()}</span>{" "}
        queries · awaiting first audit data
      </div>
    );
  }

  const live = read.staleMs < STALE_WARN_MS;

  return (
    <div className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {live && (
        <span
          aria-hidden
          className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--allow))] motion-safe:animate-live-pulse"
        />
      )}
      <span className="font-mono">{totalCount.toLocaleString()}</span> queries ·
      as of <span className="font-mono">{formatDuration(read.staleMs)} ago</span>
      {live && " · live tail"}
    </div>
  );
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const hr = Math.floor(min / 60);
  return `${hr} hour${hr === 1 ? "" : "s"}`;
}
