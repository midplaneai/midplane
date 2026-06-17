import "server-only";

import { inArray } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { user } from "@midplane-cloud/db/auth-schema";

import { bootRegion } from "./region-context.ts";

// Resolve actor user ids to a dashboard-displayable label (email, falling back
// to name, falling back to the raw id). The token-list panel calls this once
// per render with the set of creator ids; we batch into ONE query against the
// Better Auth `user` table in this region's DB rather than N round-trips.
//
// Ids not in the table (seed/E2E rows, system-mint actors) pass through as the
// raw id with resolved:false — surfaced, not hidden. A query failure degrades
// to the raw ids rather than crashing the page.

export interface ResolvedUser {
  /** Display label — email, name, or the raw id. Always non-empty. */
  label: string;
  /** True when a real user row was found; false for sentinel/seed ids and any
   *  id the lookup couldn't resolve (token list renders those muted). */
  resolved: boolean;
}

export async function resolveUsers(
  userIds: readonly string[],
): Promise<Map<string, ResolvedUser>> {
  const out = new Map<string, ResolvedUser>();
  const ids = Array.from(new Set(userIds)).filter((id) => id.length > 0);
  if (ids.length === 0) return out;
  // Default every id to unresolved (raw id); overwrite the ones we find.
  for (const id of ids) out.set(id, { label: id, resolved: false });

  try {
    const db = getDb(bootRegion());
    const rows = await db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(inArray(user.id, ids));
    for (const row of rows) {
      out.set(row.id, {
        label: row.email || row.name || row.id,
        resolved: true,
      });
    }
  } catch (err) {
    // Don't crash the page on a DB hiccup — the raw id is still a useful (if
    // uglier) display value. The pre-seeded raw-id fallbacks stay in place.
    console.error("[resolveUsers] batch lookup failed", err);
  }
  return out;
}
