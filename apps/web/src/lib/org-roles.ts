// Pure org-role helpers — no DB or session imports, so this module is safe to
// load in unit tests and (as types) in client components. The DB/session-backed
// gates (getActiveRole, requireManager, assertManager, requireManagerRest) live
// in org-auth.ts, which imports and re-exports everything here.
//
// Org roles (owner / admin / member) are a SECURITY boundary, not just a label:
// a plain member connects an agent (OAuth) and runs queries, but every
// configuration surface — tokens, policy, guardrails, DSN rotation, project +
// database CRUD, invites, role changes, SSO, and the audit log — is owner/admin
// only.

export type OrgRole = "owner" | "admin" | "member";

/** Roles that may manage the workspace (config, members, audit). */
export function isManagerRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The single owner. A few capabilities are owner-only — billing and (later)
 *  deleting the org — so the role still means something distinct from admin. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Roles an owner/admin may invite-as or assign from the members surface. The
 *  org has exactly one owner (its creator); ownership transfer isn't a Tier 1
 *  capability, so "owner" is never assignable here. */
export const ASSIGNABLE_ROLES = ["admin", "member"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(role: unknown): role is AssignableRole {
  return role === "admin" || role === "member";
}

/** Coerce an untrusted form value to an assignable role, defaulting to the
 *  least-privileged "member" so a missing or tampered field can never escalate
 *  an invite/assignment to admin. */
export function normalizeInviteRole(raw: unknown): AssignableRole {
  return isAssignableRole(raw) ? raw : "member";
}
