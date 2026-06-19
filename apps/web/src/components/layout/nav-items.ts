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

// Nav items for the current build + caller role. Self-host is uncapped and
// never bills, so the Billing item is dropped there (the /billing route itself
// also degrades to a self-host notice). A plain member operates the workspace
// but doesn't manage it: the Audit log and Billing are owner/admin only, so
// both are dropped for members (their routes also gate server-side). Cloud
// owners/admins see the full list.
export function navItemsFor({
  selfHost,
  canManage,
}: {
  selfHost: boolean;
  canManage: boolean;
}): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (selfHost && item.href === "/billing") return false;
    if (!canManage && (item.href === "/audit" || item.href === "/billing")) {
      return false;
    }
    return true;
  });
}
