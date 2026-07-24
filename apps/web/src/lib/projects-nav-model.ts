// The pure view-model behind the sidebar ProjectsNav. The repo tests logic, not
// components (no .test.tsx harness), so every render branch — degraded, empty,
// and the visible/overflow/active list — is decided HERE and unit-tested, while
// the component stays a dumb map over the result.
//
// D12: this is a DISPLAY-ONLY map. No quota line, no "+ New project" CTA — those
// stay in ProjectSwitcher + the dashboard header (single source of truth). The
// model composes the two pure primitives: activeProjectId (which row is current)
// and computeProjectNavRows (which rows show, active-visible-past-cutoff).

import { activeProjectId } from "./nav-active.ts";
import { computeProjectNavRows } from "./projects-nav-rows.ts";

// Structural subset of ProjectSwitcherRow (id/label/isSample) — kept minimal so
// this module stays free of any server (projects.ts) dependency and remains
// client-safe. A ProjectSwitcherRow is assignable to it.
export interface ProjectNavRow {
  id: string;
  label: string;
  isSample: boolean;
}

export type ProjectsNavModel =
  | { kind: "degraded" }
  | { kind: "empty" }
  | {
      kind: "list";
      visible: (ProjectNavRow & { active: boolean })[];
      /** True when rows were cut — render the "View all" link. */
      hasOverflow: boolean;
    };

export function projectsNavModel(input: {
  rows: readonly ProjectNavRow[];
  degraded: boolean;
  pathname: string;
}): ProjectsNavModel {
  if (input.degraded) return { kind: "degraded" };
  if (input.rows.length === 0) return { kind: "empty" };
  const activeId = activeProjectId(
    input.pathname,
    input.rows.map((r) => r.id),
  );
  const { visible, overflow } = computeProjectNavRows(input.rows, activeId);
  return {
    kind: "list",
    visible: visible.map((r) => ({ ...r, active: r.id === activeId })),
    hasOverflow: overflow.length > 0,
  };
}
