// Unit coverage for the pure org-role helpers (lib/org-roles.ts) — the security
// primitives behind the member-roles gate. No DB or session deps, so they test
// in isolation; the DB/session-backed gates (requireManager, assertManager,
// requireManagerRest) compose these and are exercised by the route/action
// integration paths.

import { describe, expect, it } from "vitest";

import {
  ASSIGNABLE_ROLES,
  isAssignableRole,
  isManagerRole,
  normalizeInviteRole,
} from "../src/lib/org-roles.ts";

describe("isManagerRole", () => {
  it("treats owner and admin as managers", () => {
    expect(isManagerRole("owner")).toBe(true);
    expect(isManagerRole("admin")).toBe(true);
  });

  it("treats member (and anything else) as a non-manager", () => {
    expect(isManagerRole("member")).toBe(false);
    expect(isManagerRole("")).toBe(false);
    expect(isManagerRole("Owner")).toBe(false); // case-sensitive on purpose
    expect(isManagerRole(null)).toBe(false);
    expect(isManagerRole(undefined)).toBe(false);
  });
});

describe("isAssignableRole", () => {
  it("accepts admin and member", () => {
    expect(isAssignableRole("admin")).toBe(true);
    expect(isAssignableRole("member")).toBe(true);
  });

  it("rejects owner and non-role values (no ownership transfer here)", () => {
    expect(isAssignableRole("owner")).toBe(false);
    expect(isAssignableRole("")).toBe(false);
    expect(isAssignableRole(null)).toBe(false);
    expect(isAssignableRole(undefined)).toBe(false);
    expect(isAssignableRole(42)).toBe(false);
  });

  it("exposes exactly admin and member as the assignable set", () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(["admin", "member"]);
  });
});

describe("normalizeInviteRole", () => {
  it("passes through a valid assignable role", () => {
    expect(normalizeInviteRole("admin")).toBe("admin");
    expect(normalizeInviteRole("member")).toBe("member");
  });

  it("defaults to the least-privileged member for anything else", () => {
    // A tampered select, a missing field, or an attempt to escalate to owner
    // must never mint an admin invite.
    expect(normalizeInviteRole("owner")).toBe("member");
    expect(normalizeInviteRole(undefined)).toBe("member");
    expect(normalizeInviteRole(null)).toBe("member");
    expect(normalizeInviteRole("superuser")).toBe("member");
    expect(normalizeInviteRole(1)).toBe("member");
  });
});
