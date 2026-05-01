import { EVENT_TYPES, type EventType, type VolumeBucket } from "@/lib/audit";

interface Props {
  buckets: readonly VolumeBucket[];
  /** ARIA label for the chart region. */
  label?: string;
}

// Stack order from bottom up. Mirrors the lifecycle so the "FAILED" cap
// (deny color) sits on top and is the most visible signal.
const STACK_ORDER: readonly EventType[] = [
  "ATTEMPTED",
  "DECIDED",
  "EXECUTED",
  "FAILED",
];

const FILL: Record<EventType, string> = {
  ATTEMPTED: "hsl(var(--subtle))",
  DECIDED: "hsl(var(--brand))",
  EXECUTED: "hsl(var(--allow))",
  FAILED: "hsl(var(--deny))",
};

export function VolumeSparkline({ buckets, label = "Audit volume, last 24 hours" }: Props) {
  const totalEvents = buckets.reduce(
    (sum, b) => sum + sumBucket(b.counts),
    0,
  );
  if (totalEvents === 0) return null;

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
      data-total={totalEvents}
    >
      <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-[0.04em] text-subtle">
        <span>
          <b className="font-medium text-foreground">
            {totalEvents.toLocaleString()}
          </b>{" "}
          events · last 24h
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
      {EVENT_TYPES.map((t) => (
        <span key={t} className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-[1px]"
            style={{ background: FILL[t] }}
            aria-hidden
          />
          <span className="text-muted-foreground">
            {t.charAt(0) + t.slice(1).toLowerCase()}
          </span>
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
    (t) => `${t.toLowerCase()} ${b.counts[t]}`,
  );
  return `${hourLabel(b.ts)} · ${total} event${total === 1 ? "" : "s"}${
    parts.length > 0 ? ` (${parts.join(", ")})` : ""
  }`;
}

function hourLabel(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, "0");
  return `${hh}:00`;
}
