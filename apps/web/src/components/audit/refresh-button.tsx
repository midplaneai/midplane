"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/utils";

// Manual refresh for /audit. The page is a Server Component, so a click
// here is a `router.refresh()` — Next re-runs the page's data loaders
// (listAuditQueries, eventVolumeByHour, etc.) and patches the rendered
// tree without a full reload. useTransition wraps the call so we can
// disable the button + show a "refreshing…" state for the duration of
// the round-trip; without it the click feels unresponsive on slower
// connections.
export function RefreshButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      aria-label="Refresh audit log"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] text-subtle transition-colors",
        "hover:border-border-strong hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block leading-none",
          pending && "motion-safe:animate-spin",
        )}
      >
        ↻
      </span>
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
