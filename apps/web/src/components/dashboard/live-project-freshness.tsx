"use client";

import { StatusDot } from "@/components/dashboard/status-dot";
import { useProjectFreshness } from "@/components/dashboard/freshness-provider";
import {
  resolveServing,
  SERVING_COLORS,
  SERVING_LABELS,
} from "@/lib/freshness";

// Project-level serving-readiness pill (dot + label) in the dashboard project
// header. Answers "will this project serve an MCP query" — ready / paused /
// action needed — NOT whether the audit indexer is current. Reads live
// pausedAt + database count from the polling provider, falling back to the
// server-rendered initial values until the first poll. A paused project reads
// "paused" (amber); a project with no databases reads "action needed" (the
// card below it says why). A project whose indexer is erroring still serves,
// so it reads "ready" here — see resolveServing.

export function LiveProjectFreshness({
  projectId,
  initialPausedAt,
  initialDatabaseCount,
}: {
  projectId: string;
  initialPausedAt: Date | null;
  initialDatabaseCount: number;
}) {
  const live = useProjectFreshness(projectId);
  const pausedAt = live ? live.pausedAt : initialPausedAt;
  const databaseCount = live ? live.databases.size : initialDatabaseCount;
  const { state } = resolveServing({ pausedAt, databaseCount });
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
      <StatusDot
        colorClass={SERVING_COLORS[state]}
        pulse={state === "ready"}
        label={SERVING_LABELS[state]}
      />
      {SERVING_LABELS[state]}
    </span>
  );
}
