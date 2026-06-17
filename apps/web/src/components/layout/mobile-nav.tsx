"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { LegalMenu } from "@/components/layout/legal-menu";
import { navItemsFor } from "@/components/layout/nav-items";
import { WorkspaceLabel } from "@/components/layout/workspace-label";
import { RegionBadge } from "@/components/ui/region-badge";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import type { Region } from "@midplane-cloud/kms";

export function MobileNav({
  region,
  selfHost = false,
}: {
  region: Region | null;
  selfHost?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  return (
    <div className="flex flex-col border-b border-border bg-card md:hidden">
      <div className="flex h-12 items-center gap-3 px-4">
        <WorkspaceLabel />
        <div className="ml-auto flex items-center gap-3">
          {region && <RegionBadge region={region} />}
          <button
            type="button"
            title="Sign out"
            aria-label="Sign out"
            onClick={() =>
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    router.push("/");
                    router.refresh();
                  },
                },
              })
            }
            className="text-subtle hover:text-foreground"
          >
            <LogOut aria-hidden className="h-4 w-4" strokeWidth={1.5} />
          </button>
          <LegalMenu />
        </div>
      </div>
      <nav
        aria-label="Workspace"
        className="flex items-center gap-1 overflow-x-auto px-2 pb-1"
      >
        {navItemsFor(selfHost).map((item) => {
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
