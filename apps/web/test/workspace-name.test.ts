import { describe, expect, it } from "vitest";

import {
  slugifyWorkspaceName,
  suggestWorkspaceName,
} from "../src/lib/workspace-name.ts";

describe("suggestWorkspaceName", () => {
  it("derives the company from a corporate domain", () => {
    expect(suggestWorkspaceName("dana@acme.com")).toBe("Acme");
    expect(suggestWorkspaceName("dana@acme.io", null)).toBe("Acme");
  });

  it("skips the second-level suffix on .co.uk-style domains", () => {
    expect(suggestWorkspaceName("dana@acme.co.uk")).toBe("Acme");
  });

  it("uses the registrable label, not a subdomain", () => {
    expect(suggestWorkspaceName("dana@mail.acme.com")).toBe("Acme");
    // The DB case from the smoke: lange.sent.com → the registrable domain is
    // sent.com, so "Sent" (editable by the user if that's wrong).
    expect(suggestWorkspaceName("test@lange.sent.com", "Dustin")).toBe("Sent");
  });

  it("title-cases multi-word labels", () => {
    expect(suggestWorkspaceName("dana@acme-corp.com")).toBe("Acme Corp");
  });

  it("falls back to the person's name for generic providers", () => {
    expect(suggestWorkspaceName("john.doe@gmail.com", "John Doe")).toBe(
      "John Doe's workspace",
    );
    expect(suggestWorkspaceName("dana@outlook.com", "Dana")).toBe(
      "Dana's workspace",
    );
  });

  it("falls back to the email local part when there's no name", () => {
    expect(suggestWorkspaceName("solo@gmail.com")).toBe("solo's workspace");
  });

  it("always returns a non-empty value", () => {
    expect(suggestWorkspaceName("x@gmail.com").length).toBeGreaterThan(0);
    expect(suggestWorkspaceName("weird").length).toBeGreaterThan(0);
  });
});

describe("slugifyWorkspaceName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyWorkspaceName("Acme Corp")).toBe("acme-corp");
    expect(slugifyWorkspaceName("  Hello!! World  ")).toBe("hello-world");
  });

  it("returns empty when there are no usable characters", () => {
    expect(slugifyWorkspaceName("???")).toBe("");
  });
});
