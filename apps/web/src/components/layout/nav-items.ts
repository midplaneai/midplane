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
  {
    href: "/billing",
    label: "Billing",
    icon: CreditCard,
    match: (p) => p.startsWith("/billing"),
  },
];
