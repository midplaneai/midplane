import { revalidatePath } from "next/cache";

// The sidebar project list now lives in the (app) layout — shared chrome on
// EVERY authed route. A page-scoped revalidatePath("/dashboard") only refreshes
// that one route's cached RSC payload, so the sidebar (name, membership, Sample
// badge) goes stale on other routes after a project mutation (design D11 /
// Codex #6). Revalidating the layout segment busts the shared chrome across the
// whole router cache.
//
// Call this from EVERY project-shape mutation (create / rename / delete /
// sample-add) alongside the existing page-scoped revalidations. Centralized so
// a future mutation can't silently skip it — the one failure mode here is
// invisible: stale chrome with no error.
export function revalidateProjectsChrome(): void {
  revalidatePath("/", "layout");
}
