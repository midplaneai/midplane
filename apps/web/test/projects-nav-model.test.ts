// projectsNavModel — every render branch of the display-only sidebar list,
// decided in pure logic (the repo has no component-test harness). Degraded and
// empty must stay distinct (a DB blip must never read as "you have no projects").

import { describe, expect, it } from "vitest";

import { projectsNavModel } from "../src/lib/projects-nav-model.ts";

const row = (id: string, isSample = false) => ({ id, label: id, isSample });
const ROWS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((id) =>
  row(id),
);

describe("projectsNavModel", () => {
  it("degraded (DB failure) is its own state, never the empty state", () => {
    expect(
      projectsNavModel({ rows: ROWS, degraded: true, pathname: "/dashboard" }),
    ).toEqual({ kind: "degraded" });
  });

  it("no rows → empty (distinct from degraded)", () => {
    expect(
      projectsNavModel({ rows: [], degraded: false, pathname: "/dashboard" }),
    ).toEqual({ kind: "empty" });
  });

  it("marks the active row and shows no overflow under the cap", () => {
    const model = projectsNavModel({
      rows: [row("p1"), row("p2")],
      degraded: false,
      pathname: "/projects/p2",
    });
    expect(model.kind).toBe("list");
    if (model.kind !== "list") throw new Error("expected list");
    expect(model.hasOverflow).toBe(false);
    expect(model.visible.map((r) => [r.id, r.active])).toEqual([
      ["p1", false],
      ["p2", true],
    ]);
  });

  it("keeps the active project visible past the cutoff and flags overflow", () => {
    const model = projectsNavModel({
      rows: ROWS,
      degraded: false,
      pathname: "/projects/p8",
    });
    if (model.kind !== "list") throw new Error("expected list");
    expect(model.hasOverflow).toBe(true);
    expect(model.visible.map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p8",
    ]);
    expect(model.visible.find((r) => r.id === "p8")?.active).toBe(true);
  });

  it("on /dashboard no row is active", () => {
    const model = projectsNavModel({
      rows: [row("p1"), row("p2")],
      degraded: false,
      pathname: "/dashboard",
    });
    if (model.kind !== "list") throw new Error("expected list");
    expect(model.visible.every((r) => !r.active)).toBe(true);
  });

  it("carries the sample flag through for the badge", () => {
    const model = projectsNavModel({
      rows: [row("p1"), row("p2", true)],
      degraded: false,
      pathname: "/dashboard",
    });
    if (model.kind !== "list") throw new Error("expected list");
    expect(model.visible.find((r) => r.id === "p2")?.isSample).toBe(true);
  });
});
