import { Database } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Shown on the hosted sample project (projects.is_sample). The sample is a
// shared read-only demo we own — its credential can't be rotated and its
// databases can't be extended (both refused server-side), so on its own it's
// a dead end. This is the signpost off it: it names the project as a demo and
// gives the one action that graduates the user to their own data — a real new
// project. Placed on the surface a sample user lands on (the Connect pane).
export function SampleProjectNotice({
  newProjectHref = "/projects/new",
}: {
  newProjectHref?: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-[hsl(var(--brand)/0.2)] bg-[hsl(var(--brand)/0.05)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <Database
          className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--brand))]"
          strokeWidth={1.5}
          aria-hidden
        />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            You&apos;re exploring the sample database
          </p>
          <p className="text-xs text-muted-foreground">
            It&apos;s a read-only demo and doesn&apos;t count toward your
            project limit. When you&apos;re ready, connect your own Postgres in
            a new project.
          </p>
        </div>
      </div>
      <Link
        href={newProjectHref}
        className={cn(
          buttonVariants({ variant: "default", size: "sm" }),
          "shrink-0 self-start sm:self-auto",
        )}
      >
        Connect your own database
        <span aria-hidden className="ml-2 font-mono">
          →
        </span>
      </Link>
    </div>
  );
}
