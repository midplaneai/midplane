// Who is asking: the claims of a validated agent access token.

import { z } from "zod";

export const CallerClaimsSchema = z.strictObject({
  sub: z.string().min(1),
  client_id: z.string().min(1),
  /** One human's authorization of one MCP client; taint and approvals bind here. */
  grant_id: z.string().min(1),
  tenant: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)),
});
export type CallerClaims = z.infer<typeof CallerClaimsSchema>;

/** A database's id: in gateway config, bundles, scopes and token claims. */
export const DatabaseIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "a lowercase id of up to 32 characters");

export type DatabaseAccess = "read" | "write";

/** The scope granting `access` to one database. `write` implies `read`. */
export function databaseScope(
  databaseId: string,
  access: DatabaseAccess,
): string {
  return `db:${databaseId}:${access}`;
}
