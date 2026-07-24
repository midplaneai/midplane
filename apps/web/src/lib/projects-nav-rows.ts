// Visibility rule for the sidebar project list — the projects twin of
// computeDbTabs (lib/db-tabs.ts). Same subtle branch: the ACTIVE project stays
// visible even when it sorts past the cutoff, so "View all" never hides the
// project page you're on. Pure and client-safe.
//
// 6 (not 8): the sidebar aside is overflow-y-auto with the help links and the
// account/sign-out row pinned to the bottom (mt-auto). A longer list pushes
// those below the fold on a 13" viewport, so the cap protects the always-
// visible account controls, not just tidiness.

export const MAX_VISIBLE_PROJECT_ROWS = 6;

export interface ProjectNavRows<T> {
  visible: T[];
  overflow: T[];
}

export function computeProjectNavRows<T extends { id: string }>(
  rows: readonly T[],
  activeId: string | null,
  max: number = MAX_VISIBLE_PROJECT_ROWS,
): ProjectNavRows<T> {
  let visible = rows.slice(0, max);
  if (
    activeId !== null &&
    rows.some((r) => r.id === activeId) &&
    !visible.some((r) => r.id === activeId)
  ) {
    const active = rows.find((r) => r.id === activeId)!;
    visible = [...visible.slice(0, max - 1), active];
  }
  return {
    visible,
    overflow: rows.filter((r) => !visible.includes(r)),
  };
}
