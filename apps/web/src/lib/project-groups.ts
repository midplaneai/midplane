// The pure view-model behind "which projects count, and how do they group?" —
// shared by the dashboard list, the rail-header switcher, and the two surfaces
// that only need the count (/projects/new, projects/[id]).
//
// Same contract as projects-nav-model.ts: the repo tests logic, not components
// (no .test.tsx harness), so every render branch — the counted group, the demo
// group, their headings, the separator between them — is decided HERE and
// unit-tested, while each component stays a dumb map over the result.
//
// The rule this encodes: a sample project is NOT billable. It doesn't consume a
// plan slot (createProject excludes it), so it must not be counted in "N / M"
// and must not sit in the list as a peer of the projects that are — a list of
// two beside a counter reading 1 / 1 reads as a bug in the counter. Keeping the
// split and the counter in one place is what stops them drifting apart.

/** Structural subset — kept minimal so this module stays free of any server
 *  (projects.ts) dependency and remains client-safe, like ProjectNavRow. */
export interface SampleFlagged {
  isSample: boolean;
}

export interface ProjectGrouping<T> {
  /** Counted against the plan's project cap. */
  billable: T[];
  /** Excluded from the cap; rendered in their own group. */
  samples: T[];
  /** The cap-facing count — the N in "N / M projects". */
  billableCount: number;
  /** A sample is present, so a surface may explain why it isn't counted.
   *  Worth saying only where the user is being told no; everywhere else it's
   *  noise about a project they can see isn't theirs. */
  hasSample: boolean;
  /** Render the counted group (and its heading). False on a workspace whose
   *  only project is the sample — otherwise the surface opens with a labeled
   *  group holding nothing. */
  showBillableGroup: boolean;
  /** Render the demo group (and its heading). */
  showSampleGroup: boolean;
  /** Divider between the two groups — only when both are actually rendered. */
  showGroupSeparator: boolean;
}

/** Group a customer's projects into counted vs. demo.
 *
 *  `isSample` is a selector rather than a bare `row.isSample` read because the
 *  two callers carry different row shapes: the switcher's ProjectSwitcherRow
 *  flags itself, while the dashboard's DashboardProjectRow nests the flag under
 *  `.project`. One grouping rule, either shape. */
export function groupProjectsBySample<T>(
  rows: readonly T[],
  isSample: (row: T) => boolean,
): ProjectGrouping<T> {
  const billable: T[] = [];
  const samples: T[] = [];
  for (const row of rows) {
    (isSample(row) ? samples : billable).push(row);
  }
  return {
    billable,
    samples,
    billableCount: billable.length,
    hasSample: samples.length > 0,
    showBillableGroup: billable.length > 0,
    showSampleGroup: samples.length > 0,
    showGroupSeparator: billable.length > 0 && samples.length > 0,
  };
}

/** The common case: rows that carry the flag directly (ProjectSwitcherRow and
 *  anything else shaped like it). */
export function groupProjects<T extends SampleFlagged>(
  rows: readonly T[],
): ProjectGrouping<T> {
  return groupProjectsBySample(rows, (r) => r.isSample);
}

/** Where "connect your own database" goes from the sample project.
 *
 *  This is NOT an upgrade decision, and treating it as one is a trap worth
 *  spelling out. Connecting your own Postgres needs a project SLOT only when
 *  there's no project to put it in. At the project cap there provably is one:
 *  the cap is reached by OWNING projects, and every plan's cap is at least 1,
 *  so `atProjectCap` implies at least one real project exists. Databases are
 *  capped per project (MAX_DATABASES_PER_PROJECT), never by plan — so the
 *  remedy at the cap is "add it to a project you already have", not "pay us".
 *  Routing this CTA to billing meant the single moment it fired was the single
 *  moment the user could already do the thing it was refusing them.
 *
 *  Below the cap the answer is a new project: that keeps their own data out of
 *  the shared demo container and is a slot they demonstrably have. */
export function connectOwnDataTarget<T extends { id: string }>(
  atProjectCap: boolean,
  billable: readonly T[],
): { kind: "new-project" } | { kind: "existing-project"; project: T } {
  // Defensive on `billable[0]`: the invariant above says it's present whenever
  // atProjectCap holds, but a caller passing a sample-only list must fall back
  // to the create path rather than render a link to nothing.
  const existing = atProjectCap ? billable[0] : undefined;
  return existing
    ? { kind: "existing-project", project: existing }
    : { kind: "new-project" };
}
