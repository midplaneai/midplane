"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { navItemsFor } from "@/components/layout/nav-items";
import { isOnProjectDetailPath } from "@/lib/nav-active";
import { cn } from "@/lib/utils";

export function SidebarNav({
  selfHost = false,
  role = null,
}: {
  selfHost?: boolean;
  role?: string | null;
}) {
  const pathname = usePathname() ?? "";
  // On a project detail page a ProjectsNav row carries the active rail, so
  // suppress the top-level "Projects" item's rail here — otherwise two rails
  // render at once (design D3). Pathname-only so SidebarNav stays part of the
  // instant shell chrome and never waits on the streamed project rows; mobile
  // (MobileNav) reuses NAV_ITEMS unchanged and keeps its top-item indicator.
  const suppressProjectsRail = isOnProjectDetailPath(pathname);
  return (
    <nav className="space-y-1 py-2" aria-label="Workspace">
      <div className="px-[18px] pb-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        workspace
      </div>
      {navItemsFor({ selfHost, role }).map((item) => {
        const active =
          item.match(pathname) &&
          !(item.href === "/dashboard" && suppressProjectsRail);
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
