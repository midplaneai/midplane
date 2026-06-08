"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type TerminalStatus,
  type VolumeBucket,
} from "@/lib/audit";

interface Props {
  buckets: readonly VolumeBucket[];
  /** ARIA label for the chart region. */
  label?: string;
  /** Bucket granularity — drives the axis + tooltip time labels. */
  granularity?: "hour" | "day";
  /** Header text for the window, e.g. "last 24h" / "last 7 days". */
  windowLabel?: string;
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

export function VolumeSparkline({
  buckets,
  label,
  granularity = "hour",
  windowLabel = "last 24h",
}: Props) {
  const ariaLabel = label ?? `Query volume, ${windowLabel}`;
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
      <div className="mb-1 flex items-center justify-between font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
        <span>
          <b className="font-medium text-foreground">
            {totalQueries.toLocaleString()}
          </b>{" "}
          {totalQueries === 1 ? "query" : "queries"} · {windowLabel}
        </span>
        <Legend />
      </div>
      <TooltipProvider delayDuration={80} skipDelayDuration={120}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
          className="block h-10 w-full overflow-visible"
        >
          {buckets.map((b, i) => {
            const total = sumBucket(b.counts);
            const x = i * (colW + gap);
            // Empty buckets get an invisible hover catcher so users can still
            // hit them — otherwise hover gaps make the chart feel laggy.
            return (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <g
                    className="cursor-default outline-none focus:outline-none"
                    tabIndex={-1}
                  >
                    <rect
                      x={x}
                      y={0}
                      width={colW}
                      height={h}
                      fill="transparent"
                    />
                    {(() => {
                      if (total === 0) return null;
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
                      return segs;
                    })()}
                  </g>
                </TooltipTrigger>
                <TooltipContent side="top" align="center">
                  <BucketTooltip bucket={b} granularity={granularity} />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </svg>
      </TooltipProvider>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-subtle">
        <span>{first ? `${axisLabel(first, granularity)} UTC` : ""}</span>
        <span>{last ? `${axisLabel(last, granularity)} UTC` : ""}</span>
      </div>
    </div>
  );
}

function BucketTooltip({
  bucket,
  granularity,
}: {
  bucket: VolumeBucket;
  granularity: "hour" | "day";
}) {
  const total = sumBucket(bucket.counts);
  return (
    <div className="min-w-[140px] space-y-1">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1">
        <span className="font-mono text-[11px] text-subtle">
          {rangeLabel(bucket.ts, granularity)}
        </span>
        <span className="font-mono text-[11px] text-foreground">
          {total} {total === 1 ? "query" : "queries"}
        </span>
      </div>
      {total === 0 ? (
        <div className="text-[11px] text-muted-foreground">No queries</div>
      ) : (
        <ul className="space-y-0.5">
          {STACK_ORDER.map((t) => {
            const c = bucket.counts[t] ?? 0;
            if (c === 0) return null;
            return (
              <li
                key={t}
                className="flex items-center justify-between gap-3 text-[11px]"
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-[1px]"
                    style={{ background: FILL[t] }}
                    aria-hidden
                  />
                  {LABEL[t]}
                </span>
                <span className="font-mono text-foreground">{c}</span>
              </li>
            );
          })}
        </ul>
      )}
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

function hourLabel(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, "0");
  return `${hh}:00`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function dayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Axis tick: time-of-day for hourly buckets, calendar date for daily.
function axisLabel(d: Date, granularity: "hour" | "day"): string {
  return granularity === "day" ? dayLabel(d) : hourLabel(d);
}

// Tooltip header: the hour span for hourly buckets, the whole day for daily.
function rangeLabel(d: Date, granularity: "hour" | "day"): string {
  if (granularity === "day") return `${dayLabel(d)} UTC`;
  const start = hourLabel(d);
  const end = hourLabel(new Date(d.getTime() + 3_600_000));
  return `${start}–${end} UTC`;
}
