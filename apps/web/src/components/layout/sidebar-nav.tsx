"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

export function SidebarNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="space-y-1 py-2" aria-label="Workspace">
      <div className="px-[18px] pb-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        workspace
      </div>
      {NAV_ITEMS.map((item) => {
        const active = item.match(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              // Active selection = 3px inset left rail. Same spec-sheet mark
              // used by selected radio cards and table rows. Box-shadow so it
              // doesn't push content x-position relative to inactive items.
              "flex items-center gap-2.5 px-[18px] py-[7px] text-sm transition-colors",
              active
                ? "bg-popover text-foreground shadow-[inset_3px_0_0_hsl(var(--brand))]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 flex-shrink-0",
                active ? "text-foreground" : "text-subtle",
              )}
              strokeWidth={1.5}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
