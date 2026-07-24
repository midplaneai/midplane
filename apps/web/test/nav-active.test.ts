// activeProjectId — the single "which project is active" predicate shared by
// ProjectsNav (row highlight) and SidebarNav (top-rail suppression). The branch
// that matters: /projects/new resolves to null (no row for it) so the create
// page keeps the top nav rail and no row is falsely lit.

import { describe, expect, it } from "vitest";

import {
  activeProjectId,
  isOnProjectDetailPath,
} from "../src/lib/nav-active.ts";

const IDS = ["p1", "p2", "p3"];

describe("activeProjectId", () => {
  it("returns null on /dashboard and /audit (no project in the path)", () => {
    expect(activeProjectId("/dashboard", IDS)).toBeNull();
    expect(activeProjectId("/audit", IDS)).toBeNull();
  });

  it("returns the id for /projects/<id> when it's a real project", () => {
    expect(activeProjectId("/projects/p2", IDS)).toBe("p2");
  });

  it("resolves sub-routes to the parent project id", () => {
    expect(activeProjectId("/projects/p1/settings", IDS)).toBe("p1");
    expect(activeProjectId("/projects/p3/databases/main", IDS)).toBe("p3");
  });

  it("returns null on /projects/new (no row represents it)", () => {
    expect(activeProjectId("/projects/new", IDS)).toBeNull();
  });

  it("returns null for an unknown id (foreign / just-deleted)", () => {
    expect(activeProjectId("/projects/ghost", IDS)).toBeNull();
  });

  it("returns null on an empty pathname", () => {
    expect(activeProjectId("", IDS)).toBeNull();
  });
});

describe("isOnProjectDetailPath", () => {
  it("is true on a project detail page and its sub-routes", () => {
    expect(isOnProjectDetailPath("/projects/p1")).toBe(true);
    expect(isOnProjectDetailPath("/projects/p1/settings")).toBe(true);
    expect(isOnProjectDetailPath("/projects/p1/databases/main")).toBe(true);
  });

  it("is FALSE on /projects/new (no row — top nav keeps its rail)", () => {
    expect(isOnProjectDetailPath("/projects/new")).toBe(false);
  });

  it("is false on /dashboard, /audit, and the bare /projects", () => {
    expect(isOnProjectDetailPath("/dashboard")).toBe(false);
    expect(isOnProjectDetailPath("/audit")).toBe(false);
    expect(isOnProjectDetailPath("/projects")).toBe(false);
  });
});
