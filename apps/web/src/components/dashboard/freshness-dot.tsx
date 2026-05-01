import { cn } from "@/lib/utils";
import {
  FRESHNESS_COLORS,
  FRESHNESS_LABELS,
  type Freshness,
} from "@/lib/freshness";

// 8px dot + sr-only label. Live = pulsing green; stale = static amber;
// down = static red. The pulse only paints when prefers-reduced-motion is
// not requested.

export function FreshnessDot({
  state,
  className,
}: {
  state: Freshness;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center", className)}
      aria-hidden={false}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full bg-current",
          FRESHNESS_COLORS[state],
          state === "live" && "motion-safe:animate-live-pulse",
        )}
      />
      <span className="sr-only"> {FRESHNESS_LABELS[state]}</span>
    </span>
  );
}
