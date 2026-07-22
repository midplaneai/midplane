"use client";

import { ArrowUpRight, Check, ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";

import { StatusDot } from "@/components/dashboard/status-dot";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionLabel } from "@/components/ui/section-label";
import { SERVING_COLORS, SERVING_LABELS } from "@/lib/freshness";
import type { ProjectSwitcherRow } from "@/lib/projects";
import { UPGRADE_URL } from "@/lib/routes";

// The rail header's project name as a switcher — the same affordance the
// database tabs give one level down. The chevron is the teaching device: it
// says "there can be more of these" even while the account has one project
// (the dashboard auto-opens a single project, so without this the container
// stays invisible). The dropdown doubles as a fleet glance (per-project
// freshness dots) and carries the create/upgrade affordance plus the plan's
// project quota, so the wall is visible where the mental model forms.

export function ProjectSwitcher({
  projects,
  currentId,
  canManage,
  atCap,
  quotaLine,
  upgradeHref = UPGRADE_URL,
}: {
  projects: ProjectSwitcherRow[];
  currentId: string;
  /** Members see the list but no create/upgrade row (they can't add
   *  projects — mirrors the dashboard header's gating). */
  canManage: boolean;
  /** Project cap reached (advisory pre-flight — /projects/new re-checks). */
  atCap: boolean;
  /** Footer usage line, e.g. "free plan · 1/1 projects". Null = unlimited
   *  tier, no line. */
  quotaLine: string | null;
  upgradeHref?: string;
}) {
  const current = projects.find((p) => p.id === currentId);
  const currentLabel = current?.label ?? currentId.slice(0, 12);

  return (
    <div>
      {/* Eyebrow mirrors the DatabaseStrip's ("Database") so the two boxed
          identities read as a labeled pair across the gutter — `project` over
          the switcher, `database` over the active tab — and the container
          vocabulary is literally printed on the page. */}
      <SectionLabel className="mb-2">Project</SectionLabel>
      <DropdownMenu>
        {/* Boxed with the active database card-tab's exact metrics (padding,
            border-strong, bg-card, shadow, 24px line box) so the two sit at
            the same height across the gutter; hover/open pick up the
            sidebar's active-row surface (bg-popover); keyboard focus gets
            the system ring (Button/Input convention — a bg shift alone is
            imperceptible on this palette). Type stays Geist — project names
            are human labels (dashboard cards agree); mono is for the
            database identifiers. */}
        <DropdownMenuTrigger
          aria-label={`Switch project — current: ${currentLabel}`}
          className="group flex w-full items-center gap-2 rounded-md border border-border-strong bg-card px-3.5 py-2 text-left shadow-sm outline-none transition-colors hover:bg-popover data-[state=open]:bg-popover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span
            title={currentLabel}
            className="min-w-0 flex-1 truncate text-base font-medium leading-6 tracking-tight text-foreground"
          >
            {currentLabel}
          </span>
          {current?.isSample ? (
            <Badge withDot={false} className="flex-shrink-0">
              Sample
            </Badge>
          ) : null}
          <ChevronsUpDown
            aria-hidden
            className="h-3.5 w-3.5 flex-shrink-0 text-subtle transition-colors group-hover:text-foreground group-focus-visible:text-foreground group-data-[state=open]:text-foreground"
            strokeWidth={1.5}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[210px] overflow-y-auto"
        >
          <DropdownMenuLabel className="font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
            projects
          </DropdownMenuLabel>
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} asChild>
              <Link
                href={`/projects/${p.id}`}
                aria-current={p.id === currentId ? "page" : undefined}
                title={p.label}
                className="gap-2"
              >
                {/* Serving-readiness headline dot (Axis 1) — quiet (no
                    pulse) inside a menu of many rows. */}
                <StatusDot
                  colorClass={SERVING_COLORS[p.serving]}
                  label={SERVING_LABELS[p.serving]}
                />
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                {p.isSample ? (
                  <Badge withDot={false} className="flex-shrink-0">
                    Sample
                  </Badge>
                ) : null}
                {p.id === currentId ? (
                  <Check
                    aria-hidden
                    className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
                    strokeWidth={1.5}
                  />
                ) : null}
              </Link>
            </DropdownMenuItem>
          ))}
          {canManage ? (
            <>
              <DropdownMenuSeparator />
              {atCap ? (
                <DropdownMenuItem asChild>
                  <Link href={upgradeHref} className="gap-2">
                    <ArrowUpRight
                      aria-hidden
                      className="h-3.5 w-3.5 text-subtle"
                      strokeWidth={1.5}
                    />
                    Upgrade to add more
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem asChild>
                  <Link href="/projects/new" className="gap-2">
                    <Plus
                      aria-hidden
                      className="h-3.5 w-3.5 text-subtle"
                      strokeWidth={1.5}
                    />
                    New project
                  </Link>
                </DropdownMenuItem>
              )}
            </>
          ) : null}
          {quotaLine ? (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
                {quotaLine}
              </div>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
