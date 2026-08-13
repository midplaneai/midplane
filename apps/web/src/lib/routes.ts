// Cross-surface route constants + tiny URL-param predicates. Pure module —
// no server-only deps — so "use client" components may import it freely.
// (lib/plan re-exports UPGRADE_URL for its existing server-side callers, but
// plan.ts reaches the Node-only db driver through resolvePlan's dynamic
// import of customer.ts, so client code imports from HERE instead.)

/** Where a capped user goes to upgrade. Relative so it resolves on whichever
 *  regional host served the request. */
export const UPGRADE_URL = "/billing";

/** The projects list. Plain /dashboard: it used to carry ?list=1 because the
 *  dashboard bounced a single-project account straight to its only project,
 *  and the breadcrumbs needed a way to say "no, the list". The bounce is gone,
 *  so the param is too — one destination, one URL. */
export const PROJECTS_LIST_HREF = "/dashboard";
