"use client";

import { ArrowUpRight, Database } from "lucide-react";
import Link from "next/link";

import { AddDatabaseSheet } from "@/components/projects/add-database-sheet";
import { SectionLabel } from "@/components/ui/section-label";
import { computeDbTabs } from "@/lib/db-tabs";
import { UPGRADE_URL } from "@/lib/routes";
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
  projectAtCap = false,
  sample = false,
  sampleConnect,
  newProjectHref = "/projects/new",
  upgradeHref = UPGRADE_URL,
  statusSlot,
}: {
  databases: string[];
  current: string;
  projectId: string;
  addAction: (formData: FormData) => Promise<void>;
  showAdd?: boolean;
  /** One line under the row, speaking for the CURRENT database — whether the
   *  engine is enforcing what the pane below shows, and the links that check
   *  it. Rendered here rather than in the pane body so it's read on arrival
   *  instead of found after scrolling past the controls it describes. */
  statusSlot?: React.ReactNode;
  /** Fixed per-project database ceiling reached (advisory pre-flight — the add
   *  path re-checks under a lock). Swaps the add affordance for the next step
   *  out, so the wall is visible BEFORE a filled-in form fails against it. The
   *  ceiling is plan-independent, so the first remedy is another project, not
   *  an upgrade — unless `projectAtCap` says another project isn't creatable
   *  either. */
  atCap?: boolean;
  /** The plan's PROJECT cap is also reached. Only read when `atCap` is true,
   *  and only to keep that link honest: "create another project to add more"
   *  pointed at /projects/new regardless, so a user already at their project
   *  limit was invited to do the one thing that route would refuse. At both
   *  caps the remedy really is an upgrade, so the link says so and goes to
   *  billing. */
  projectAtCap?: boolean;
  /** This is the hosted sample project. Adding a database is refused on the
   *  server (it's our shared read-only demo), so instead of an add control we
   *  point at the customer's own data — the "graduate off the sample" path,
   *  placed exactly where a user would look to bring it in. */
  sample?: boolean;
  /** Where that graduate-off-the-sample link goes, from connectOwnDataTarget
   *  (lib/project-groups.ts): a new project, or an existing one when the plan's
   *  project cap is reached. Never billing — the project cap doesn't gate
   *  adding a database to a project the customer already has. Omitted (or on a
   *  non-sample project) falls back to newProjectHref. */
  sampleConnect?: { href: string; intoExistingProject: boolean };
  newProjectHref?: string;
  upgradeHref?: string;
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
            // Graduating off the sample never depends on the PLAN — only on
            // where the database lands. At the project cap it goes into a
            // project the customer already owns (databases are capped per
            // project, not per plan); below the cap it gets its own new one.
            // Routing this to billing would refuse the funnel's key step at
            // exactly the moment the customer could already complete it.
            <Link
              href={sampleConnect?.href ?? newProjectHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[hsl(var(--brand)/0.35)] px-3 py-2 text-sm text-subtle transition-colors hover:border-[hsl(var(--brand)/0.6)] hover:bg-[hsl(var(--brand)/0.05)] hover:text-foreground"
            >
              {sampleConnect?.intoExistingProject
                ? "Add your own database"
                : "Connect your own database"}
              <ArrowUpRight
                className="h-3.5 w-3.5"
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
          ) : atCap ? (
            <Link
              href={projectAtCap ? upgradeHref : newProjectHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-subtle transition-colors hover:border-border-strong hover:text-foreground"
            >
              {projectAtCap
                ? "Upgrade to add more"
                : "Create another project to add more"}
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
      {statusSlot ? <div className="mt-2">{statusSlot}</div> : null}
    </div>
  );
}
