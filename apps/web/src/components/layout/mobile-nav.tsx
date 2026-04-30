"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandLockup } from "@/components/layout/brand-mark";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

export function MobileNav() {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex flex-col border-b border-border bg-card md:hidden">
      <div className="flex h-12 items-center gap-3 px-4">
        <Link href="/dashboard" className="flex-shrink-0">
          <BrandLockup />
        </Link>
        <div className="ml-auto">
          <UserButton afterSignOutUrl="/" />
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
                "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
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
