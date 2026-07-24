// computeProjectNavRows — the sidebar list's visibility rule. Mirrors
// db-tabs.test.ts: the branch that matters is the ACTIVE project staying
// visible even when it sorts past the 6-row cutoff.

import { describe, expect, it } from "vitest";

import {
  computeProjectNavRows,
  MAX_VISIBLE_PROJECT_ROWS,
} from "../src/lib/projects-nav-rows.ts";

const row = (id: string) => ({ id, label: id });
const ROWS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map(row);

describe("computeProjectNavRows", () => {
  it("shows all rows with no overflow under the cap", () => {
    const rows = ["p1", "p2"].map(row);
    expect(computeProjectNavRows(rows, "p1")).toEqual({
      visible: rows,
      overflow: [],
    });
  });

  it("caps visible rows at 6 and overflows the rest", () => {
    const { visible, overflow } = computeProjectNavRows(ROWS, "p1");
    expect(visible.map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(overflow.map((r) => r.id)).toEqual(["p7", "p8"]);
    expect(visible).toHaveLength(MAX_VISIBLE_PROJECT_ROWS);
  });

  it("always keeps the active project visible past the cutoff", () => {
    const { visible, overflow } = computeProjectNavRows(ROWS, "p8");
    expect(visible.map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p8",
    ]);
    expect(overflow.map((r) => r.id)).toEqual(["p6", "p7"]);
  });

  it("no active project (on /dashboard) → first 6, no forced swap", () => {
    const { visible, overflow } = computeProjectNavRows(ROWS, null);
    expect(visible.map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(overflow.map((r) => r.id)).toEqual(["p7", "p8"]);
  });

  it("handles an active id not in the list (race: just deleted)", () => {
    const { visible, overflow } = computeProjectNavRows(ROWS, "ghost");
    expect(visible.map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(overflow.map((r) => r.id)).toEqual(["p7", "p8"]);
  });

  it("empty list → empty visible and overflow", () => {
    expect(computeProjectNavRows([], null)).toEqual({
      visible: [],
      overflow: [],
    });
  });
});
