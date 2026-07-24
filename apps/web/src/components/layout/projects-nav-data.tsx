import { ProjectsNav } from "@/components/layout/projects-nav";
import { currentCustomer } from "@/lib/customer";
import {
  listProjectSwitcherRows,
  type ProjectSwitcherRow,
} from "@/lib/projects";

// Async server component that feeds the client ProjectsNav. Rendered behind a
// <Suspense> boundary in AppShell (design D10) so the shell paints immediately
// and this streams in — the projects query never blocks /audit, /billing, or
// any other authed route. currentCustomer() and listProjectSwitcherRows() are
// both cache()-wrapped, so this shares the layout's / project route's reads
// instead of adding new ones.
//
// The try/catch (design D4) is the blast-radius guard: the shared chrome must
// survive a failed project query. Latency isolation is the Suspense boundary's
// job; error isolation is this catch's — two separate concerns (Codex #5).
export async function ProjectsNavData() {
  // Only the DATA fetch is guarded; the JSX is constructed once, outside the
  // try/catch (a return inside try wouldn't catch render errors anyway — that's
  // what the Suspense boundary + degraded flag are for).
  let rows: ProjectSwitcherRow[] = [];
  let degraded = false;
  try {
    const customer = await currentCustomer();
    rows = customer ? await listProjectSwitcherRows(customer) : [];
  } catch (err) {
    console.error("[ProjectsNavData] failed to load projects", err);
    degraded = true;
  }
  return <ProjectsNav rows={rows} degraded={degraded} />;
}

// Suspense fallback — two muted placeholder rows under the "projects" label, so
// the sidebar's shape is stable while the list streams in.
export function ProjectsNavSkeleton() {
  return (
    <div className="space-y-1 py-2" aria-hidden>
      <div className="px-[18px] pb-1 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        projects
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="px-[18px] py-[7px]">
          <div className="h-3.5 w-24 animate-pulse bg-muted" />
        </div>
      ))}
    </div>
  );
}
