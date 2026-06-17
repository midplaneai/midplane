"use client";

import Link from "next/link";

import { authClient } from "@/lib/auth-client";

// The active organization's name, shown next to the two-dot WorkspaceMark in
// the sidebar / mobile nav and linking to workspace settings. Replaces Clerk's
// <OrganizationSwitcher>: one org == one customer, so there's nothing to switch
// — it's a label + a way into settings, not a picker. Falls back to "workspace"
// until the org name loads.
export function WorkspaceLabel() {
  const { data: org, isPending } = authClient.useActiveOrganization();
  return (
    <Link
      href="/settings"
      title="Workspace settings"
      className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors hover:text-muted-foreground"
    >
      {isPending ? "" : (org?.name ?? "workspace")}
    </Link>
  );
}
