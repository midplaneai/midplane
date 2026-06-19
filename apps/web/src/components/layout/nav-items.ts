import {
  CreditCard,
  Database,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

import { isManagerRole, isOwnerRole } from "@/lib/org-roles";

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
// also degrades to a self-host notice). Role gating: a plain member operates
// the workspace but doesn't manage it, so the Audit log (owner/admin) is hidden
// from members; Billing is OWNER-ONLY (admins manage the workspace but not the
// money), so it's hidden from admins too. Every gated route also enforces
// server-side. `role` is null when unresolved → treated as least-privileged.
export function navItemsFor({
  selfHost,
  role,
}: {
  selfHost: boolean;
  role: string | null;
}): NavItem[] {
  const canManage = isManagerRole(role);
  const owner = isOwnerRole(role);
  return NAV_ITEMS.filter((item) => {
    if (item.href === "/billing") return owner && !selfHost;
    if (item.href === "/audit") return canManage;
    return true;
  });
}
