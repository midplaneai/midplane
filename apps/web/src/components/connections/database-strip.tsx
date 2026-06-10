"use client";

import { Database } from "lucide-react";

import { AddDatabaseSheet } from "@/components/connections/add-database-sheet";
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
  connectionId,
  addAction,
  showAdd = true,
}: {
  databases: string[];
  current: string;
  connectionId: string;
  addAction: (formData: FormData) => Promise<void>;
  showAdd?: boolean;
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
      <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
        Database
      </p>
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
          <AddDatabaseSheet connectionId={connectionId} addAction={addAction} />
        ) : null}
      </div>
    </div>
  );
}
