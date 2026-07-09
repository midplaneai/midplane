// Cross-surface route constants + tiny URL-param predicates. Pure module —
// no server-only deps — so "use client" components may import it freely.
// (lib/plan re-exports UPGRADE_URL for its existing server-side callers, but
// plan.ts reaches the Node-only db driver through resolvePlan's dynamic
// import of customer.ts, so client code imports from HERE instead.)

/** Where a capped user goes to upgrade. Relative so it resolves on whichever
 *  regional host served the request. */
export const UPGRADE_URL = "/billing";

/** The explicit "show me the projects list" intent. /dashboard auto-opens a
 *  single-project account's only project; this param skips that bounce so
 *  the list — with its N / cap counter and create/upgrade CTA — stays
 *  reachable from the breadcrumbs. */
export const PROJECT_LIST_PARAM = "list";
export const PROJECT_LIST_VALUE = "1";
export const PROJECTS_LIST_HREF = `/dashboard?${PROJECT_LIST_PARAM}=${PROJECT_LIST_VALUE}`;

/** Whether the ?list= search param asks for the list view. Next.js delivers
 *  a duplicated param as string[] — accept the value anywhere in the array
 *  so ?list=1&list=1 still reads as "list". */
export function wantsProjectList(
  list: string | string[] | undefined,
): boolean {
  return Array.isArray(list)
    ? list.includes(PROJECT_LIST_VALUE)
    : list === PROJECT_LIST_VALUE;
}
