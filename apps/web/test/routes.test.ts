// lib/routes.ts — the pure route-constant module client components import
// (plan.ts re-exports UPGRADE_URL from here for server callers).

import { describe, expect, it } from "vitest";

import { PROJECTS_LIST_HREF, UPGRADE_URL } from "../src/lib/routes.ts";

describe("route constants", () => {
  it("keeps the upgrade route relative (resolves on either regional host)", () => {
    expect(UPGRADE_URL).toBe("/billing");
  });

  it("points the list at plain /dashboard — one destination, one URL", () => {
    // Was "/dashboard?list=1": the dashboard used to bounce a single-project
    // account to its only project, so breadcrumbs needed a param to ask for
    // the list itself. The bounce is gone, and with it the param — a link to
    // the projects list is just a link to the projects list.
    expect(PROJECTS_LIST_HREF).toBe("/dashboard");
  });
});
