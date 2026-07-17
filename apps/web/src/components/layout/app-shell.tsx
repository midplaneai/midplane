import { helpLinksFor } from "@/components/layout/help-links";
import { LegalMenu } from "@/components/layout/legal-menu";
import { MobileNav } from "@/components/layout/mobile-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenuButton } from "@/components/layout/user-menu-button";
import { WorkspaceLabel } from "@/components/layout/workspace-label";
import { RegionBadge } from "@/components/ui/region-badge";
import type { Region } from "@midplane-cloud/kms";

interface AppShellProps {
  /** null in self-host — there's one region and no routing, so the badge is
   *  hidden rather than showing a meaningless "Europe (Frankfurt)". */
  region: Region | null;
  /** Self-host build: drops the Billing nav item (uncapped, never bills). */
  selfHost?: boolean;
  /** Caller's org role — drives nav gating: owner sees everything (incl.
   *  Billing), admin sees the Audit log but not Billing, a member sees only
   *  Projects. Those routes also gate server-side; this is just the nav. */
  role?: string | null;
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

export function AppShell({
  region,
  selfHost = false,
  role = null,
  children,
}: AppShellProps) {
  return (
    <div className="grid min-h-screen md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto border-r border-border bg-card py-4 md:flex">
        <div className="px-[18px] pb-5">
          <div className="flex items-center gap-2.5 py-[7px]">
            <WorkspaceMark />
            <WorkspaceLabel />
          </div>
        </div>
        <SidebarNav selfHost={selfHost} role={role} />
        {region && (
          <>
            <div className="mt-2 px-[18px] pb-1 pt-2 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
              region
            </div>
            <div className="px-[18px] py-[7px]">
              <RegionBadge region={region} />
            </div>
          </>
        )}
        <div className="mt-auto">
          {/* Always-visible help links, pinned above the account row — Docs
              and a path to a human on every screen, not tucked in a menu. */}
          <nav aria-label="Help" className="space-y-1 py-2">
            <div className="px-[18px] pb-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
              help
            </div>
            {helpLinksFor({ selfHost }).map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  {...(item.newTab
                    ? { target: "_blank", rel: "noreferrer" }
                    : {})}
                  className="flex items-center gap-2.5 px-[18px] py-[7px] text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon
                    aria-hidden
                    className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
                    strokeWidth={1.5}
                  />
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="flex items-center gap-2 border-t border-border px-[18px] py-[7px]">
            <div className="min-w-0 flex-1">
              <UserMenuButton />
            </div>
            {/* Imprint / Privacy / Terms tucked behind a [⋯] menu — keeps the
                § 5 TMG Imprint reachable in-app without spending a footer row. */}
            <LegalMenu />
          </div>
        </div>
      </aside>
      <main className="min-w-0">
        <MobileNav region={region} selfHost={selfHost} role={role} />
        {children}
      </main>
    </div>
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
