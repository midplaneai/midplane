import { OrganizationSwitcher } from "@clerk/nextjs";
import Link from "next/link";

import { MobileNav } from "@/components/layout/mobile-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenuButton } from "@/components/layout/user-menu-button";
import { RegionBadge } from "@/components/ui/region-badge";
import type { Region } from "@midplane-cloud/kms";

interface AppShellProps {
  region: Region;
  children: React.ReactNode;
}

// Two-dot mark — the colon broken into its parts, applied to navigation
// chrome. Mirrors the wordmark's blue colon and tells the user this is
// the mid:plane app without taking up an icon's worth of space.
function WorkspaceMark() {
  return (
    <span
      aria-hidden
      className="inline-flex flex-shrink-0 items-center gap-[3px]"
    >
      <span className="block h-[5px] w-[5px] rounded-full bg-[hsl(var(--brand))]" />
      <span className="block h-[5px] w-[5px] rounded-full bg-[hsl(var(--brand))]" />
    </span>
  );
}

export function AppShell({ region, children }: AppShellProps) {
  return (
    <div className="grid min-h-screen md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto border-r border-border bg-card py-4 md:flex">
        <div className="px-[18px] pb-5">
          <div className="flex items-center gap-2.5 py-[7px]">
            <WorkspaceMark />
            <OrganizationSwitcher
              hidePersonal
              afterCreateOrganizationUrl="/signup/region"
              afterSelectOrganizationUrl="/dashboard"
              appearance={{
                elements: {
                  rootBox: "min-w-0 flex-1",
                  organizationSwitcherTrigger:
                    "w-full justify-between gap-2 px-0 py-0 hover:bg-transparent",
                  organizationPreview: "min-w-0 gap-0",
                  organizationPreviewAvatarBox: "hidden",
                  organizationPreviewMainIdentifier:
                    "truncate text-sm font-normal text-foreground",
                },
              }}
            />
          </div>
        </div>
        <SidebarNav />
        <div className="mt-2 px-[18px] pb-1 pt-2 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
          region
        </div>
        <div className="px-[18px] py-[7px]">
          <RegionBadge region={region} />
        </div>
        <div className="mt-auto border-t border-border px-[18px] py-[7px]">
          <UserMenuButton />
        </div>
      </aside>
      <main className="flex min-w-0 flex-col">
        <MobileNav region={region} />
        <div className="flex-1">{children}</div>
        <AppLegalFooter />
      </main>
    </div>
  );
}

// Persistent legal links, reachable from every authenticated page on both
// desktop and mobile. Required so the § 5 TMG Imprint stays reachable inside
// the app, not just from the marketing footer. Lowercase mono is the product
// chrome voice (see DESIGN.md).
function AppLegalFooter() {
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-6 py-4 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
      <Link href="/imprint" className="transition-colors hover:text-foreground">
        imprint
      </Link>
      <Link href="/privacy" className="transition-colors hover:text-foreground">
        privacy
      </Link>
      <Link href="/terms" className="transition-colors hover:text-foreground">
        terms
      </Link>
    </footer>
  );
}

interface TopbarProps {
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function Topbar({ children, actions }: TopbarProps) {
  return (
    <header className="flex h-12 items-center gap-4 border-b border-border bg-background px-6">
      <div className="text-sm text-muted-foreground">{children}</div>
      {actions ? <div className="ml-auto">{actions}</div> : null}
    </header>
  );
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[1280px] p-6">{children}</div>;
}
