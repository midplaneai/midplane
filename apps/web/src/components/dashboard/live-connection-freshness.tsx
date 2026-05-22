"use client";

import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import { useConnectionFreshness } from "@/components/dashboard/freshness-provider";
import {
  computeFreshness,
  FRESHNESS_LABELS,
} from "@/lib/freshness";

// Connection-level freshness pill (dot + UPPERCASE label) rendered in
// the connection header. Reads the live cursor from the polling
// provider, falling back to the server-rendered initial values when
// the provider hasn't seen its first poll yet (i.e. immediately after
// page load).

export function LiveConnectionFreshness({
  connectionId,
  initialLastIndexedAt,
  initialLastErrorAt,
}: {
  connectionId: string;
  initialLastIndexedAt: Date | null;
  initialLastErrorAt: Date | null;
}) {
  const live = useConnectionFreshness(connectionId);
  const cursor = live?.cursor ?? {
    lastIndexedAt: initialLastIndexedAt,
    lastErrorAt: initialLastErrorAt,
  };
  const state = computeFreshness(cursor);
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
      <FreshnessDot state={state} />
      {FRESHNESS_LABELS[state]}
    </span>
  );
}
