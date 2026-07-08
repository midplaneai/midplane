import { cn } from "@/lib/utils";

// 8px status dot + sr-only label. Generic over the health axis: the caller
// passes the resolved text-color class, whether to pulse, and the sr-only
// label. Serving-readiness headlines pass SERVING_COLORS / SERVING_LABELS;
// a future audit-log line can reuse it with its own tokens. The pulse only
// paints when prefers-reduced-motion is not requested.

export function StatusDot({
  colorClass,
  pulse = false,
  label,
  className,
}: {
  /** Tailwind text-color class controlling the dot fill (bg-current). */
  colorClass: string;
  /** Gentle "alive" pulse — reserved for the healthy/ready state. */
  pulse?: boolean;
  /** Screen-reader label for the state. */
  label: string;
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
          colorClass,
          pulse && "motion-safe:animate-live-pulse",
        )}
      />
      <span className="sr-only"> {label}</span>
    </span>
  );
}
