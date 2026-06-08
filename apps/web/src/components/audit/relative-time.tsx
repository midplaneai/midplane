// Plain server-rendered relative time. The page is a server component, so
// "Ns ago" reflects request time — close enough for a feed that the user
// will refresh, and avoids client hydration churn for every row.

export function relativeTime(d: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - d.getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Absolute UTC timestamp for the audit list when the user toggles off
 *  relative time. `YYYY-MM-DD HH:MM:SS` — second precision matters for
 *  forensic ordering; "UTC" is implied by the page's UTC convention and
 *  rendered alongside by the caller. */
export function absoluteTime(d: Date): string {
  const iso = d.toISOString(); // 2026-06-08T08:59:44.123Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}
