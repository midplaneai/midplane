// accessLabel — shared by the dashboard rows and the project home.
// The interpunct form ("read · write") matches the audit log's badge
// copy; pin all four branches.

import { describe, expect, it } from "vitest";

import { accessLabel } from "../src/lib/policy-labels.ts";

describe("accessLabel", () => {
  it("maps the three policy levels and passes unknowns through", () => {
    expect(accessLabel("read")).toBe("read");
    expect(accessLabel("deny")).toBe("deny");
    expect(accessLabel("read_write")).toBe("read · write");
    expect(accessLabel("future_level")).toBe("future_level");
  });
});
