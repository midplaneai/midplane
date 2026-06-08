import Link from "next/link";

import { cn } from "@/lib/utils";
import { AUDIT_WINDOWS, type AuditWindowKey } from "@/lib/audit";

const LABELS: Record<AuditWindowKey, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};

// Segmented time-window control. URL-driven (each segment is a Link) so the
// page stays a server component and the window survives refresh / share.
// Mirrors the chip vocabulary; the active segment reads as the brand-strong
// surface like an active filter chip.
export function WindowSelect({
  selected,
  hrefFor,
}: {
  selected: AuditWindowKey;
  hrefFor: (w: AuditWindowKey) => string;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-border bg-secondary p-0.5"
      role="group"
      aria-label="Time window"
    >
      {AUDIT_WINDOWS.map((w) => {
        const active = w === selected;
        return (
          <Link
            key={w}
            href={hrefFor(w)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-[5px] px-2 py-0.5 font-mono text-[11px] tracking-[0.04em] transition-colors",
              active
                ? "bg-popover text-foreground"
                : "text-subtle hover:text-foreground",
            )}
          >
            {LABELS[w]}
          </Link>
        );
      })}
    </div>
  );
}
