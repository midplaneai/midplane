// Midplane staff identity — the internal-operator seam.
//
// Staff are Midplane employees, NOT customer org members, so org-role checks
// (isManager / isOwnerRole) never apply to them. Identity is a user-level
// allowlist read from the env var MIDPLANE_STAFF_USER_IDS (comma-separated
// Better Auth user ids). Fail-closed by construction: unset or empty means no
// staff identity exists, so every staff-gated surface denies.
//
// Two consumers today, one seam:
//   - the staff escape hatch POST /admin/customer/[id]/region (route handler),
//   - the internal admin stats page GET /admin (server component).
// Both resolve the acting userId via getOrgContext() and gate on isStaffUserId.

/** Parse the allowlist env var into a set of user ids. Empty set when unset. */
export function staffUserIds(): Set<string> {
  const raw = process.env.MIDPLANE_STAFF_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Whether the given user id is a Midplane staff operator. Null/undefined (an
 *  unauthenticated request) is never staff. */
export function isStaffUserId(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return staffUserIds().has(userId);
}
