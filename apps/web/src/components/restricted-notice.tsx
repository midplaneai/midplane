import Link from "next/link";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// Shown when a member opens an owner/admin-only page directly. The nav hides
// these links for members and the routes gate server-side, but the URL is still
// reachable (a bookmark, a shared link) — a clear "not accessible" notice reads
// better than a silent redirect that drops them somewhere they didn't ask for.
// Renders inside the AppShell chrome, so the sidebar + workspace context stay.
export function RestrictedNotice({ label }: { label: string }) {
  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label }]} />
      </Topbar>
      <PageContainer>
        <EmptyState
          title="Not accessible"
          description="This page is available to workspace owners and admins. Ask an owner or admin if you need access."
          action={
            <Link href="/dashboard">
              <Button size="sm" variant="outline">
                Back to projects
              </Button>
            </Link>
          }
        />
      </PageContainer>
    </>
  );
}
