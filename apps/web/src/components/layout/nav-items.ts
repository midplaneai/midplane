import {
  CreditCard,
  Database,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

// Single source of truth for both the desktop sidebar and the mobile top bar.
// Keep this list short; the mobile bar grows ugly past ~3 items, at which
// point we'd switch to a hamburger drawer.
export const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Projects",
    icon: Database,
    match: (p) => p === "/dashboard" || p.startsWith("/projects"),
  },
  {
    href: "/audit",
    label: "Audit log",
    icon: ScrollText,
    match: (p) => p.startsWith("/audit"),
  },
  {
    href: "/billing",
    label: "Billing",
    icon: CreditCard,
    match: (p) => p.startsWith("/billing"),
  },
];

// Nav items for the current build. Self-host is uncapped and never bills, so
// the Billing item is dropped there (the /billing route itself also degrades to
// a self-host notice). Cloud shows the full list.
export function navItemsFor(selfHost: boolean): NavItem[] {
  if (!selfHost) return NAV_ITEMS;
  return NAV_ITEMS.filter((item) => item.href !== "/billing");
}
