// Relative-time formatting shared by the dashboard rows, the per-DB
// detail page, and the token list. One clock, one vocabulary — the
// short form ("12m ago") is the product's default; the long form
// ("12 minutes ago") is for prose-y meta lines (token list).
//
// Pure functions: `now` is injectable so server components can pass a
// single render-time clock (hydration-stable) and tests can pin time.
// Future timestamps clamp to "just now" — never emit negative ages.

export function formatRelative(d: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - d.getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Meta-line copy for a database's last agent query — shared by the
 *  dashboard rows and the connection home so the two surfaces can't
 *  drift ("awaiting first query" / "last query 12m ago"). */
export function lastQueryLabel(
  lastQueryAt: Date | null,
  now: Date = new Date(),
): string {
  if (!lastQueryAt) return "awaiting first query";
  return `last query ${formatRelative(lastQueryAt, now)}`;
}

/** Display label for a connection — the user's name, or a stable
 *  id-prefix fallback for unnamed connections. One definition for the
 *  five surfaces that render it. */
export function connectionLabel(conn: {
  name: string | null;
  id: string;
}): string {
  return conn.name ?? conn.id.slice(0, 12);
}

export function formatRelativeLong(d: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - d.getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
