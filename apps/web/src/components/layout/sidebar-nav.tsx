"use client";

import { Database, ScrollText, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Connections",
    icon: Database,
    match: (p) => p === "/dashboard" || p.startsWith("/connections"),
  },
  {
    href: "/audit",
    label: "Audit log",
    icon: ScrollText,
    match: (p) => p.startsWith("/audit"),
  },
];

export function SidebarNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="space-y-1 py-2" aria-label="Workspace">
      <div className="px-[18px] pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle">
        Workspace
      </div>
      {ITEMS.map((item) => {
        const active = item.match(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 border-l-2 border-transparent px-[18px] py-[7px] text-sm transition-colors",
              active
                ? "border-l-[hsl(var(--brand))] bg-popover text-foreground"
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
