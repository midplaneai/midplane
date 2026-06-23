// classifyAccountDeletion — the pure rule deciding what deleting your account
// does to your workspace, given your role and how many OTHER members it has.
// The account page renders the matching danger zone from this, and the
// beforeDelete backstop (lib/workspace.ts) enforces the same outcome, so the
// boundaries here are a contract both sides depend on.

import { describe, expect, it } from "vitest";

import { classifyAccountDeletion } from "@/lib/org-roles";

describe("classifyAccountDeletion", () => {
  it("blocks an owner with other members (never orphan a shared workspace)", () => {
    expect(
      classifyAccountDeletion({ role: "owner", otherMemberCount: 1 }),
    ).toBe("blocked-owner");
    expect(
      classifyAccountDeletion({ role: "owner", otherMemberCount: 5 }),
    ).toBe("blocked-owner");
  });

  it("tears down the workspace when the owner is the sole member", () => {
    expect(
      classifyAccountDeletion({ role: "owner", otherMemberCount: 0 }),
    ).toBe("delete-workspace");
  });

  it("lets a non-owner just leave, regardless of head count", () => {
    for (const role of ["admin", "member"] as const) {
      expect(
        classifyAccountDeletion({ role, otherMemberCount: 0 }),
      ).toBe("leave");
      expect(
        classifyAccountDeletion({ role, otherMemberCount: 3 }),
      ).toBe("leave");
    }
  });

  it("treats a lone admin as leave, not workspace deletion (only an owner owns the workspace)", () => {
    // Defensive: an admin who happens to be the only remaining member still
    // just leaves — the workspace (and its absent owner's data) is not theirs
    // to delete.
    expect(
      classifyAccountDeletion({ role: "admin", otherMemberCount: 0 }),
    ).toBe("leave");
  });
});
