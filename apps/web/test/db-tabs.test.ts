// computeDbTabs — the context strip's visibility rule. The subtle
// branch this pins: the CURRENT db must stay visible even when it
// sorts past the cutoff (a strip that hides the page you're on reads
// as broken navigation).

import { describe, expect, it } from "vitest";

import { computeDbTabs, MAX_VISIBLE_DB_TABS } from "../src/lib/db-tabs.ts";

const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

describe("computeDbTabs", () => {
  it("shows all tabs with no overflow under the cap", () => {
    expect(computeDbTabs(["main", "staging"], "main")).toEqual({
      visible: ["main", "staging"],
      overflow: [],
    });
  });

  it("caps visible tabs and overflows the rest", () => {
    const { visible, overflow } = computeDbTabs(NAMES, "alpha");
    expect(visible).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(overflow).toEqual(["epsilon", "zeta"]);
    expect(visible).toHaveLength(MAX_VISIBLE_DB_TABS);
  });

  it("always keeps the current db visible past the cutoff", () => {
    const { visible, overflow } = computeDbTabs(NAMES, "zeta");
    expect(visible).toEqual(["alpha", "beta", "gamma", "zeta"]);
    expect(visible).toContain("zeta");
    expect(overflow).toEqual(["delta", "epsilon"]);
  });

  it("handles a current db not in the list (race: just removed)", () => {
    const { visible, overflow } = computeDbTabs(NAMES, "ghost");
    expect(visible).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(overflow).toEqual(["epsilon", "zeta"]);
  });

  it("single-db project renders one tab, no overflow", () => {
    expect(computeDbTabs(["main"], "main")).toEqual({
      visible: ["main"],
      overflow: [],
    });
  });
});
