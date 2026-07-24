"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  projectsNavModel,
  type ProjectNavRow,
} from "@/lib/projects-nav-model";
import { PROJECTS_LIST_HREF } from "@/lib/routes";
import { cn } from "@/lib/utils";

// The ambient sidebar project map (design D12): DISPLAY-ONLY — the list, the
// current-project rail, the Sample badge, and a "View all" overflow link. The
// N/M quota and the "+ New project" CTA deliberately live elsewhere (the
// rail-header ProjectSwitcher + the dashboard header) so there's ONE quota
// source of truth. Props-fed + usePathname only; all render branches come from
// the pure projectsNavModel (unit-tested), so this component is a dumb map.
export function ProjectsNav({
  rows,
  degraded = false,
}: {
  rows: ProjectNavRow[];
  degraded?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const model = projectsNavModel({ rows, degraded, pathname });

  // A brand-new customer always has the auto-seeded Default project, so an
  // empty list is a race, not a normal state — render nothing rather than an
  // empty section.
  if (model.kind === "empty") return null;

  return (
    <nav className="space-y-1 py-2" aria-label="Projects">
      <div className="px-[18px] pb-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        projects
      </div>
      {model.kind === "degraded" ? (
        // Distinct from the empty state (D4): a DB blip must never read as
        // "you have no projects". The top-level Projects nav item still routes
        // to /dashboard, so navigation survives.
        <div className="px-[18px] py-[7px] text-sm text-subtle">
          Projects unavailable
        </div>
      ) : (
        <>
          {model.visible.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              aria-current={p.active ? "page" : undefined}
              title={p.label}
              className={cn(
                // Same 3px inset brand rail as SidebarNav's active row.
                "flex items-center gap-2 px-[18px] py-[7px] text-sm transition-colors",
                p.active
                  ? "bg-popover text-foreground shadow-[inset_3px_0_0_hsl(var(--brand))]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              {p.isSample ? (
                <Badge withDot={false} className="flex-shrink-0">
                  Sample
                </Badge>
              ) : null}
            </Link>
          ))}
          {model.hasOverflow ? (
            <Link
              href={PROJECTS_LIST_HREF}
              className="block px-[18px] py-[7px] text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
            </Link>
          ) : null}
        </>
      )}
    </nav>
  );
}
