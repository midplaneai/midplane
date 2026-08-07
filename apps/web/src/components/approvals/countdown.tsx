"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// Live countdown to a request's deadline.
//
// A client component on purpose, and the only one on these pages. The server
// renders a static "21m" that is correct the instant it renders and then quietly
// lies — which matters here more than on most surfaces, because the number IS
// the pressure: an approver deciding whether to read the statement now or later
// is reading this. A stale "21m" on a tab left open for half an hour actively
// misinforms.
//
// Ticks every second, always. An earlier version throttled to ten seconds above
// a minute to save renders, which was a false economy: the display shows m:ss,
// so it sat visibly frozen and then jumped 7:03 → 6:53. A clock that stutters
// reads as broken, and the whole point of this component is that the number can
// be trusted. One setState per second on one node is not a cost worth managing.
//
// Nothing animates — DESIGN.md keeps motion to the freshness pulse and spinners,
// and a number that changes is information, not decoration. Reduced-motion users
// get the same thing; there is no transition to suppress.

export function Countdown({
  expiresAt,
  title,
  className,
}: {
  /** ISO string — a Date would re-serialize differently across the RSC boundary. */
  expiresAt: string;
  title?: string;
  className?: string;
}) {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());

  useEffect(() => {
    // Re-sync immediately on mount: the server-rendered value is already stale
    // by however long hydration took.
    setRemaining(target - Date.now());
    const id = setInterval(() => setRemaining(target - Date.now()), 1_000);
    return () => clearInterval(id);
  }, [target]);

  const sec = Math.floor(remaining / 1000);
  const expired = sec <= 0;
  // Five minutes is when "I'll get to it" stops being true.
  const urgent = !expired && sec <= 5 * 60;

  return (
    <span
      title={title}
      // aria-live so a screen reader is told when the window actually closes,
      // without narrating every tick along the way.
      aria-live={expired ? "polite" : "off"}
      className={cn(
        "whitespace-nowrap font-mono tabular-nums",
        expired ? "text-deny" : urgent ? "text-warn" : "text-muted-foreground",
        className,
      )}
    >
      {format(sec)}
    </span>
  );
}

function format(sec: number): string {
  if (sec <= 0) return "expired";
  if (sec < 60) return `0:${String(sec).padStart(2, "0")}`;
  const min = Math.floor(sec / 60);
  // Under an hour, show m:ss — the seconds are what make it read as a clock
  // rather than a static label.
  if (min < 60) return `${min}:${String(sec % 60).padStart(2, "0")}`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
