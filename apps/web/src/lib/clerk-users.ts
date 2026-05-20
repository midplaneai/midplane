import "server-only";

// Resolve Clerk user ids to a dashboard-displayable label (primary
// email, falling back to the user's name, falling back to the id). The
// token list panel calls this once per render with the set of creator
// ids; we batch the lookups against Clerk's getUserList endpoint so the
// list doesn't fan out to N round-trips.
//
// Sentinel ids (e.g. seed/E2E rows stamped 'user_e2e_seed', system-mint
// actors that aren't real Clerk users) are passed through unchanged —
// Clerk returns nothing for them and we surface the raw id rather than
// hiding it. Failure of the whole batch (network blip, Clerk outage) is
// caught here and degrades to the raw id rather than crashing the page.

export interface ResolvedClerkUser {
  /** The display label — email, name, or the raw id when nothing
   *  better is available. Always non-empty. */
  label: string;
  /** True when Clerk returned a real user row. False for sentinel /
   *  seed ids and any user the lookup couldn't resolve. The token list
   *  renders the raw id with a muted color in the unresolved case. */
  resolved: boolean;
}

export async function resolveClerkUsers(
  userIds: readonly string[],
): Promise<Map<string, ResolvedClerkUser>> {
  const out = new Map<string, ResolvedClerkUser>();
  const real = userIds.filter((id) => id.startsWith("user_"));
  const sentinel = userIds.filter((id) => !id.startsWith("user_"));
  for (const id of sentinel) {
    out.set(id, { label: id, resolved: false });
  }
  if (real.length === 0) return out;

  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    const { data } = await client.users.getUserList({
      userId: real,
      // Clerk's default page size is 10; bump so a connection with
      // many sibling tokens minted by distinct actors resolves in one
      // call. 100 is Clerk's hard cap.
      limit: 100,
    });
    const found = new Set<string>();
    for (const user of data) {
      found.add(user.id);
      out.set(user.id, {
        label: labelForUser(user),
        resolved: true,
      });
    }
    for (const id of real) {
      if (!found.has(id)) {
        out.set(id, { label: id, resolved: false });
      }
    }
  } catch (err) {
    // Don't crash the page on a Clerk hiccup — the raw id is still a
    // useful (if uglier) display value. Log loudly so the operator can
    // catch a Clerk credential / scope misconfig.
    console.error("[resolveClerkUsers] batch lookup failed", err);
    for (const id of real) {
      if (!out.has(id)) {
        out.set(id, { label: id, resolved: false });
      }
    }
  }
  return out;
}

interface ClerkUserLike {
  primaryEmailAddress?: { emailAddress?: string | null } | null;
  emailAddresses?: ReadonlyArray<{ emailAddress?: string | null }>;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  id: string;
}

function labelForUser(user: ClerkUserLike): string {
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses?.[0]?.emailAddress;
  if (email) return email;
  const first = user.firstName?.trim();
  const last = user.lastName?.trim();
  if (first || last) return [first, last].filter(Boolean).join(" ");
  if (user.username) return user.username;
  return user.id;
}
