"use client";

import { ArrowUpRight, Database } from "lucide-react";
import Link from "next/link";

import { AddDatabaseSheet } from "@/components/projects/add-database-sheet";
import { SectionLabel } from "@/components/ui/section-label";
import { computeDbTabs } from "@/lib/db-tabs";
import { cn } from "@/lib/utils";

// The headline of the Database pane: which database you're configuring,
// rendered as a prominent card/tab so "this is current" is unmistakable and
// the set reads as extendable. NOT a global nav spine — it only governs the
// per-DB content below it.
//
// Active database → a filled card-tab (the headline). Other databases →
// quiet switch buttons; clicking navigates (?db=) so per-DB server actions
// rebind while the live ?section is preserved. "Add database" sits directly
// under the row so growing the set is right where the databases live.

export function DatabaseStrip({
  databases,
  current,
  projectId,
  addAction,
  showAdd = true,
  atCap = false,
  sample = false,
  newProjectHref = "/projects/new",
}: {
  databases: string[];
  current: string;
  projectId: string;
  addAction: (formData: FormData) => Promise<void>;
  showAdd?: boolean;
  /** Fixed per-project database ceiling reached (advisory pre-flight — the add
   *  path re-checks under a lock). Swaps the add affordance for a "create
   *  another project" link so the wall is visible BEFORE a filled-in form
   *  fails against it. The ceiling is plan-independent, so the remedy is
   *  another project, not an upgrade. */
  atCap?: boolean;
  /** This is the hosted sample project. Adding a database is refused on the
   *  server (it's our shared read-only demo), so instead of an add control we
   *  point at a real new project — the "graduate off the sample" path, placed
   *  exactly where a user would look to bring in their own data. */
  sample?: boolean;
  newProjectHref?: string;
}) {
  function go(name: string) {
    if (name === current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("db", name);
    window.location.assign(url.toString());
  }

  const { visible, overflow } = computeDbTabs(databases, current);

  return (
    <div className="mb-7">
      <SectionLabel className="mb-2">Database</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        {visible.map((name) => {
          const isCurrent = name === current;
          return isCurrent ? (
            <span
              key={name}
              aria-current="page"
              className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-card px-3.5 py-2 shadow-sm"
            >
              <Database
                className="h-4 w-4 text-[hsl(var(--brand))]"
                strokeWidth={1.5}
                aria-hidden
              />
              <span className="font-mono text-base font-medium text-foreground">
                {name}
              </span>
            </span>
          ) : (
            <button
              key={name}
              type="button"
              onClick={() => go(name)}
              className="inline-flex items-center rounded-md border border-transparent px-3 py-2 font-mono text-sm text-subtle transition-colors hover:border-border hover:bg-card hover:text-foreground"
            >
              {name}
            </button>
          );
        })}
        {overflow.length > 0 ? (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md px-3 py-2 font-mono text-sm text-subtle transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              +{overflow.length} more ▾
            </summary>
            <div className="absolute left-0 z-20 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover py-1">
              {overflow.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => go(name)}
                  className={cn(
                    "block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-muted hover:text-foreground",
                    name === current
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </details>
        ) : null}
        {showAdd ? (
          sample ? (
            <Link
              href={newProjectHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[hsl(var(--brand)/0.35)] px-3 py-2 text-sm text-subtle transition-colors hover:border-[hsl(var(--brand)/0.6)] hover:bg-[hsl(var(--brand)/0.05)] hover:text-foreground"
            >
              Connect your own database
              <ArrowUpRight
                className="h-3.5 w-3.5"
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
          ) : atCap ? (
            <Link
              href={newProjectHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-subtle transition-colors hover:border-border-strong hover:text-foreground"
            >
              Create another project to add more
              <ArrowUpRight
                className="h-3.5 w-3.5"
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
          ) : (
            <AddDatabaseSheet projectId={projectId} addAction={addAction} />
          )
        ) : null}
      </div>
    </div>
  );
}
