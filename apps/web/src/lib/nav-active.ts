// Which project (if any) the current path is viewing — the SINGLE source of
// truth for both the sidebar project-row highlight (ProjectsNav) and the
// top-level "Projects" nav item's active-rail suppression (SidebarNav). Pure
// and client-safe (no server deps).
//
// Returns the project id when the path is /projects/<id> (or a sub-route like
// /projects/<id>/settings or /projects/<id>/databases/<name>) AND that id is a
// real project in the list. Everything else — /dashboard, /audit, and crucially
// /projects/new (which has no row) — resolves to null. That null is what keeps
// the top nav item's rail on the create page while never falsely lighting a row.

const PROJECT_PATH_RE = /^\/projects\/([^/]+)/;

export function activeProjectId(
  pathname: string,
  projectIds: readonly string[],
): string | null {
  const match = PROJECT_PATH_RE.exec(pathname);
  if (!match) return null;
  const candidate = match[1]!;
  return projectIds.includes(candidate) ? candidate : null;
}

// Whether the path is a project DETAIL page (a ProjectsNav row will carry the
// active rail there). Used by SidebarNav to suppress the top-level "Projects"
// item's rail so only ONE rail renders on a project page. Deliberately
// pathname-only (no id list): SidebarNav is part of the instant shell chrome
// and must not wait on the streamed project rows. /projects/new is excluded —
// it has no row, so the top item keeps its rail there (no dead indicator).
// A just-deleted project id in the URL is the one imperfect case (suppressed
// with no row to light), but that page 404s anyway.
const PROJECT_DETAIL_RE = /^\/projects\/(?!new(?:\/|$))[^/]+/;

export function isOnProjectDetailPath(pathname: string): boolean {
  return PROJECT_DETAIL_RE.test(pathname);
}
