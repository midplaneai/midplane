"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { helpLinksFor } from "@/components/layout/help-links";
import { LegalMenu } from "@/components/layout/legal-menu";
import { navItemsFor } from "@/components/layout/nav-items";
import { UserMenuButton } from "@/components/layout/user-menu-button";
import { WorkspaceLabel } from "@/components/layout/workspace-label";
import { RegionBadge } from "@/components/ui/region-badge";
import { cn } from "@/lib/utils";
import type { Region } from "@midplane-cloud/kms";

export function MobileNav({
  region,
  selfHost = false,
  role = null,
}: {
  region: Region | null;
  selfHost?: boolean;
  role?: string | null;
}) {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex flex-col border-b border-border bg-card md:hidden">
      <div className="flex h-12 items-center gap-3 px-4">
        <WorkspaceLabel />
        <div className="ml-auto flex items-center gap-3">
          {region && <RegionBadge region={region} />}
          <UserMenuButton variant="compact" />
          <LegalMenu />
        </div>
      </div>
      <nav
        aria-label="Workspace and help"
        className="flex items-center gap-1 overflow-x-auto px-2 pb-1"
      >
        {navItemsFor({ selfHost, role }).map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                // Horizontal twin of the sidebar's 3px inset left rail.
                "inline-flex items-center gap-1.5 whitespace-nowrap border-b-[3px] px-3 py-2 text-sm transition-colors",
                active
                  ? "border-[hsl(var(--brand))] text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
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
        {/* Help links ride the same strip, after the workspace items — on
            narrow screens they may start off-screen and scroll into view (the
            strip scrolls horizontally). No active state — they're external. */}
        {helpLinksFor({ selfHost }).map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              {...(item.newTab ? { target: "_blank", rel: "noreferrer" } : {})}
              className="inline-flex items-center gap-1.5 whitespace-nowrap border-b-[3px] border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon
                aria-hidden
                className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
                strokeWidth={1.5}
              />
              {item.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
