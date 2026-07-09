// lib/routes.ts — the pure route-constant module client components import
// (plan.ts re-exports UPGRADE_URL from here for server callers).

import { describe, expect, it } from "vitest";

import {
  PROJECTS_LIST_HREF,
  UPGRADE_URL,
  wantsProjectList,
} from "../src/lib/routes.ts";

describe("route constants", () => {
  it("keeps the upgrade route relative (resolves on either regional host)", () => {
    expect(UPGRADE_URL).toBe("/billing");
  });

  it("derives the list href from the param constants (no drift)", () => {
    expect(PROJECTS_LIST_HREF).toBe("/dashboard?list=1");
  });
});

describe("wantsProjectList", () => {
  it("matches the explicit list intent", () => {
    expect(wantsProjectList("1")).toBe(true);
  });

  it("rejects absent or other values (the auto-open default)", () => {
    expect(wantsProjectList(undefined)).toBe(false);
    expect(wantsProjectList("")).toBe(false);
    expect(wantsProjectList("true")).toBe(false);
    expect(wantsProjectList("0")).toBe(false);
  });

  it("handles a duplicated param (Next delivers string[])", () => {
    // ?list=1&list=1 must still read as "list" — a strict === "1" on the
    // array form would silently fall through to the redirect.
    expect(wantsProjectList(["1", "1"])).toBe(true);
    expect(wantsProjectList(["0", "1"])).toBe(true);
    expect(wantsProjectList(["0", "2"])).toBe(false);
    expect(wantsProjectList([])).toBe(false);
  });
});
