import { BookOpen, LifeBuoy, type LucideIcon } from "lucide-react";

import { DOCS_HOME_URL } from "@/lib/docs";
import { GITHUB_ISSUES_URL, supportMailto } from "@/lib/support";

export interface HelpLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** target=_blank for real pages; a mailto stays in-tab. */
  newTab: boolean;
}

// Always-visible help links — single source of truth for the desktop sidebar
// and the mobile bar, mirroring nav-items.ts. Docs applies to every build;
// the support entry is the cloud mailbox, or GitHub issues on self-host where
// that IS the support channel (a self-host install shouldn't advertise a
// cloud mailbox that can't see its instance).
export function helpLinksFor({ selfHost }: { selfHost: boolean }): HelpLink[] {
  return [
    { href: DOCS_HOME_URL, label: "Docs", icon: BookOpen, newTab: true },
    selfHost
      ? {
          href: GITHUB_ISSUES_URL,
          label: "GitHub issues",
          icon: LifeBuoy,
          newTab: true,
        }
      : {
          href: supportMailto({ subject: "Midplane support" }),
          label: "Email support",
          icon: LifeBuoy,
          newTab: false,
        },
  ];
}
