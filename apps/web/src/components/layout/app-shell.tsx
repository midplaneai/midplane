import { UserButton } from "@clerk/nextjs";
import { MapPin } from "lucide-react";

import { BrandLockup } from "@/components/layout/brand-mark";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { REGION_LABELS } from "@/lib/region";
import type { Region } from "@midplane-cloud/kms";

interface AppShellProps {
  email: string;
  region: Region;
  children: React.ReactNode;
}

export function AppShell({ email, region, children }: AppShellProps) {
  const initial = email.charAt(0).toUpperCase();
  const workspaceName = email.split("@")[0] ?? email;

  return (
    <div className="grid min-h-screen md:grid-cols-[220px_1fr]">
      <aside className="hidden flex-col border-r border-border bg-card py-4 md:flex">
        <div className="px-[18px] pb-5">
          <BrandLockup />
        </div>
        <SidebarNav />
        <div className="mt-2 px-[18px] pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle">
          Region
        </div>
        <div className="flex items-center gap-2.5 px-[18px] py-[7px] text-sm text-muted-foreground">
          <MapPin
            aria-hidden
            className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
            strokeWidth={1.5}
          />
          {REGION_LABELS[region]}
        </div>
        <div className="mt-auto flex items-center gap-2.5 border-t border-border px-[18px] py-3 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#4a5d72] to-[#2c3e50] text-[10px] font-semibold text-foreground"
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-foreground">
              {workspaceName}
            </div>
            <div className="text-[11px] text-subtle">Free plan</div>
          </div>
          <UserButton afterSignOutUrl="/" />
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
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
