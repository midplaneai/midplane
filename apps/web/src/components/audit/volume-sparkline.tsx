import {
  TERMINAL_STATUSES,
  type TerminalStatus,
  type VolumeBucket,
} from "@/lib/audit";

interface Props {
  buckets: readonly VolumeBucket[];
  /** ARIA label for the chart region. */
  label?: string;
}

// Stack order from bottom up. Executed sits at the base (the dominant
// happy-path color), denied/failed cap on top so policy + error signals
// are the most visible.
const STACK_ORDER: readonly TerminalStatus[] = ["executed", "denied", "failed"];

const FILL: Record<TerminalStatus, string> = {
  executed: "hsl(var(--allow))",
  denied: "hsl(var(--deny))",
  failed: "hsl(var(--warn))",
};

const LABEL: Record<TerminalStatus, string> = {
  executed: "Executed",
  denied: "Denied",
  failed: "Failed",
};

export function VolumeSparkline({ buckets, label = "Query volume, last 24 hours" }: Props) {
  const totalQueries = buckets.reduce(
    (sum, b) => sum + sumBucket(b.counts),
    0,
  );
  if (totalQueries === 0) return null;

  const max = buckets.reduce((m, b) => Math.max(m, sumBucket(b.counts)), 0);
  const w = 100;
  const h = 28;
  const gap = 0.4;
  const colW = (w - gap * (buckets.length - 1)) / buckets.length;
  const first = buckets[0]?.ts;
  const last = buckets[buckets.length - 1]?.ts;

  return (
    <div
      className="mb-3 border-b border-border pb-3"
      data-testid="volume-sparkline"
      data-total={totalQueries}
    >
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-[0.04em] text-subtle">
        <span>
          <b className="font-medium text-foreground">
            {totalQueries.toLocaleString()}
          </b>{" "}
          {totalQueries === 1 ? "query" : "queries"} · last 24h
        </span>
        <Legend />
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="block h-10 w-full"
      >
        {buckets.map((b, i) => {
          const total = sumBucket(b.counts);
          if (total === 0) return null;
          const x = i * (colW + gap);
          let yCursor = h;
          const segs: React.ReactNode[] = [];
          for (const t of STACK_ORDER) {
            const c = b.counts[t] ?? 0;
            if (c === 0) continue;
            const segH = (c / max) * h;
            yCursor -= segH;
            segs.push(
              <rect
                key={t}
                x={x}
                y={yCursor}
                width={colW}
                height={segH}
                fill={FILL[t]}
              />,
            );
          }
          return (
            <g key={i}>
              {segs}
              <title>{tooltip(b)}</title>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-subtle">
        <span>{first ? hourLabel(first) : ""}</span>
        <span>{last ? hourLabel(last) : ""}</span>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-2 text-[10px] normal-case tracking-normal">
      {STACK_ORDER.map((t) => (
        <span key={t} className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-[1px]"
            style={{ background: FILL[t] }}
            aria-hidden
          />
          <span className="text-muted-foreground">{LABEL[t]}</span>
        </span>
      ))}
    </span>
  );
}

function sumBucket(c: VolumeBucket["counts"]): number {
  let s = 0;
  for (const t of STACK_ORDER) s += c[t] ?? 0;
  return s;
}

function tooltip(b: VolumeBucket): string {
  const total = sumBucket(b.counts);
  const parts = STACK_ORDER.filter((t) => (b.counts[t] ?? 0) > 0).map(
    (t) => `${b.counts[t]} ${t}`,
  );
  return `${hourLabel(b.ts)} · ${total} ${total === 1 ? "query" : "queries"}${
    parts.length > 0 ? ` (${parts.join(", ")})` : ""
  }`;
}

function hourLabel(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, "0");
  return `${hh}:00`;
}
