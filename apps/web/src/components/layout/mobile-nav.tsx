"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/components/layout/nav-items";
import { RegionBadge } from "@/components/ui/region-badge";
import { cn } from "@/lib/utils";
import type { Region } from "@midplane-cloud/kms";

export function MobileNav({ region }: { region: Region }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex flex-col border-b border-border bg-card md:hidden">
      <div className="flex h-12 items-center gap-3 px-4">
        <OrganizationSwitcher
          hidePersonal
          afterCreateOrganizationUrl="/signup/region"
          afterSelectOrganizationUrl="/dashboard"
        />
        <div className="ml-auto flex items-center gap-3">
          <RegionBadge region={region} />
          {/* afterSignOutUrl moved to <ClerkProvider> in app/layout.tsx —
              the per-button prop was removed in Clerk Core 3 (v7). */}
          <UserButton />
        </div>
      </div>
      <nav
        aria-label="Workspace"
        className="flex items-center gap-1 overflow-x-auto px-2 pb-1"
      >
        {NAV_ITEMS.map((item) => {
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
      </nav>
    </div>
  );
}
