// lib/project-groups.ts — the pure view-model deciding which projects count
// against the plan cap and how the counted/demo groups render. The repo has no
// .test.tsx harness, so these render branches are decided in the model and
// asserted here (same contract as projects-nav-model.test.ts).

import { describe, expect, it } from "vitest";

import {
  connectOwnDataTarget,
  groupProjects,
  groupProjectsBySample,
} from "../src/lib/project-groups.ts";

import { CAPS, projectQuota } from "../src/lib/plan.ts";

function row(id: string, isSample = false) {
  return { id, isSample };
}

describe("groupProjects", () => {
  it("splits counted projects from samples and counts only the counted ones", () => {
    const g = groupProjects([
      row("prod"),
      row("demo", true),
      row("staging"),
    ]);
    expect(g.billable.map((r) => r.id)).toEqual(["prod", "staging"]);
    expect(g.samples.map((r) => r.id)).toEqual(["demo"]);
    expect(g.billableCount).toBe(2);
    expect(g.hasSample).toBe(true);
  });

  it("keeps the counter off the sample — the 2-listed-1-used bug", () => {
    // A Free workspace (cap 1) that tried the sample lists two projects. If the
    // sample counted, the header would read 2/1 and the create CTA would wall
    // off a project the plan does allow.
    const g = groupProjects([row("prod"), row("demo", true)]);
    expect(g.billableCount).toBe(1);
  });

  it("renders both groups with a separator when both are present", () => {
    const g = groupProjects([row("prod"), row("demo", true)]);
    expect(g.showBillableGroup).toBe(true);
    expect(g.showSampleGroup).toBe(true);
    expect(g.showGroupSeparator).toBe(true);
  });

  it("suppresses the counted group when the sample is the only project", () => {
    // Otherwise the switcher opens on a "projects" heading with nothing under
    // it — the account genuinely owns no counted project yet.
    const g = groupProjects([row("demo", true)]);
    expect(g.showBillableGroup).toBe(false);
    expect(g.showSampleGroup).toBe(true);
    expect(g.showGroupSeparator).toBe(false);
    expect(g.billableCount).toBe(0);
  });

  it("shows no demo group and no separator without a sample", () => {
    const g = groupProjects([row("prod")]);
    expect(g.showSampleGroup).toBe(false);
    expect(g.showGroupSeparator).toBe(false);
    expect(g.hasSample).toBe(false);
  });

  it("handles an empty workspace without claiming a group to render", () => {
    const g = groupProjects([]);
    expect(g).toMatchObject({
      billable: [],
      samples: [],
      billableCount: 0,
      hasSample: false,
      showBillableGroup: false,
      showSampleGroup: false,
      showGroupSeparator: false,
    });
  });

  it("preserves input order within each group", () => {
    // The callers pass newest-first rows and render the result directly, so a
    // reordering here would silently reshuffle the dashboard list.
    const g = groupProjects([
      row("a"),
      row("s1", true),
      row("b"),
      row("s2", true),
      row("c"),
    ]);
    expect(g.billable.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(g.samples.map((r) => r.id)).toEqual(["s1", "s2"]);
  });
});

describe("connectOwnDataTarget", () => {
  it("sends you to a new project when you have room", () => {
    const t = connectOwnDataTarget(false, [row("prod")]);
    expect(t).toEqual({ kind: "new-project" });
  });

  it("sends you to an existing project at the cap — never to billing", () => {
    // The regression this guards: the at-cap branch used to route the sample's
    // "connect your own database" CTA to /billing. Bringing your own Postgres
    // needs a project SLOT only when there's nowhere to put it; at the cap
    // there is somewhere, and the database ceiling is per-project, not per-plan.
    const t = connectOwnDataTarget(true, [row("prod"), row("staging")]);
    expect(t).toEqual({ kind: "existing-project", project: row("prod") });
  });

  it("at-cap always has a project to offer — the invariant behind the fix", () => {
    // atProjectCap can only be true when billableCount >= caps.projects, and
    // every plan's cap is >= 1. So the CTA never fires with an empty list, and
    // "upgrade to connect your own data" was wrong in 100% of the cases where
    // it rendered. Assert the implication across the real cap table.
    for (const plan of ["free", "pro"] as const) {
      const caps = CAPS[plan];
      const billable = Array.from({ length: caps.projects }, (_, i) =>
        row(`p${i}`),
      );
      expect(projectQuota({ billableProjects: billable.length, caps, plan }).atCap).toBe(
        true,
      );
      expect(connectOwnDataTarget(true, billable).kind).toBe("existing-project");
    }
  });

  it("falls back to a new project if the list somehow holds no real project", () => {
    // Defensive: the invariant above says this can't happen, but a caller
    // passing a sample-only list must not produce a link to nothing.
    expect(connectOwnDataTarget(true, []).kind).toBe("new-project");
  });
});

describe("groupProjectsBySample (selector form)", () => {
  it("reads the flag through a selector for nested row shapes", () => {
    // The dashboard's DashboardProjectRow nests the flag under `.project`,
    // unlike the switcher's self-flagging ProjectSwitcherRow. One rule, both
    // shapes — that's why the selector exists.
    const rows = [
      { project: { id: "prod", isSample: false } },
      { project: { id: "demo", isSample: true } },
    ];
    const g = groupProjectsBySample(rows, (r) => r.project.isSample);
    expect(g.billable.map((r) => r.project.id)).toEqual(["prod"]);
    expect(g.samples.map((r) => r.project.id)).toEqual(["demo"]);
    expect(g.billableCount).toBe(1);
  });

  it("agrees with groupProjects on the same data", () => {
    const flat = [row("prod"), row("demo", true)];
    const viaSelector = groupProjectsBySample(flat, (r) => r.isSample);
    expect(viaSelector).toEqual(groupProjects(flat));
  });
});
