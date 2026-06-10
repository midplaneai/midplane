"use client";

import { useState } from "react";

import {
  CONNECTION_SECTIONS,
  type ConnectionSection,
} from "@/components/connections/connection-sections";
import { cn } from "@/lib/utils";

// Master-detail workspace for one connection. A persistent left rail holds
// every aspect of the connection — connection-wide (Agents, Test, Settings)
// and per-database (Access, Source) as peers — so any surface is one click
// from any other. No "inside a database" sub-room, no ambiguous up-link:
// the connection name is the rail header (the frame you're in), not a
// destination you navigate to.
//
// The rail is deliberately NOT a list of databases — multi-DB is a quiet
// switcher in the header (rendered by the page), not the organizing axis.
//
// Each pane is server-rendered by the page and handed in as a node; this
// wrapper owns the rail, which pane is shown, and ?section= sync so the
// row menu / db strip / bookmarks can deep-link a specific pane.

export function ConnectionRail({
  initialSection,
  header,
  panes,
}: {
  initialSection: ConnectionSection;
  /** Connection identity + (when >1 db) the database switcher. */
  header: React.ReactNode;
  panes: Record<ConnectionSection, React.ReactNode>;
}) {
  const [section, setSection] = useState<ConnectionSection>(initialSection);

  function select(next: ConnectionSection) {
    setSection(next);
    // Sync the URL without a navigation: panes are already in the payload,
    // so switching stays instant while deep links still resolve.
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    window.history.replaceState(null, "", url.toString());
  }

  return (
    <div className="flex gap-8">
      <aside className="sticky top-6 w-[180px] shrink-0 self-start">
        {header}
        <nav className="mt-5 flex flex-col gap-0.5" aria-label="Connection">
          {CONNECTION_SECTIONS.map((s) => {
            const active = s.value === section;
            return (
              <button
                key={s.value}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => select(s.value)}
                className={cn(
                  "flex w-full items-center border-l-[3px] px-3 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "border-[hsl(var(--brand))] font-medium text-foreground"
                    : "border-transparent text-subtle hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">{panes[section]}</div>
    </div>
  );
}
