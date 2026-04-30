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
    <div className="md-banner" role="status" data-testid="staleness-banner">
      <span className="md-banner-mark" />
      <span>
        <b>Audit data is {formatDuration(read.staleMs)} stale.</b> Indexer
        paused (recovering). Hot path unaffected.
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
      <span className="md-subtitle">
        <span className="mono">{totalCount.toLocaleString()}</span> queries ·
        awaiting first audit data
      </span>
    );
  }

  return (
    <span className="md-subtitle">
      {read.staleMs < STALE_WARN_MS && <span className="md-live-dot" />}
      <span className="mono">{totalCount.toLocaleString()}</span> queries · as
      of <span className="mono">{formatDuration(read.staleMs)} ago</span>
      {read.staleMs < STALE_WARN_MS && " · live tail"}
    </span>
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
