import type { StalenessRead } from "@/lib/audit";

const STALE_WARN_MS = 30_000;

export function StalenessSubtitle({
  read,
  totalCount,
}: {
  read: StalenessRead;
  totalCount: number;
}) {
  if (read.staleMs === null) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{totalCount.toLocaleString()}</span>{" "}
        queries · awaiting first audit data
      </div>
    );
  }

  const live = read.staleMs < STALE_WARN_MS;

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
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
