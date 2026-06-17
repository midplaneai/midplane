"use client";

import { authClient } from "@/lib/auth-client";

// The active organization's name, shown next to the two-dot WorkspaceMark in
// the sidebar / mobile nav. Replaces Clerk's <OrganizationSwitcher>: one org
// == one customer, so there's nothing to switch — this is a label, not a
// picker. Falls back to "workspace" until the org name loads.
export function WorkspaceLabel() {
  const { data: org, isPending } = authClient.useActiveOrganization();
  return (
    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
      {isPending ? "" : (org?.name ?? "workspace")}
    </span>
  );
}
