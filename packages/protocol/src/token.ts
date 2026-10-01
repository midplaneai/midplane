// The claims of an agent access token (RFC 9068 JWT profile). Not strict:
// a JWT may carry registered claims beyond these, which are ignored.

import { z } from "zod";
import {
  type CallerClaims,
  DatabaseIdSchema,
  databaseScope,
} from "./claims.ts";

/** Database access by database id, e.g. `{ "main": "read" }`. `write` implies `read`. */
export const DatabaseGrantsSchema = z.record(
  DatabaseIdSchema,
  z.enum(["read", "write"]),
);
export type DatabaseGrants = z.infer<typeof DatabaseGrantsSchema>;

export const AccessTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.number().int(),
  iat: z.number().int().optional(),
  nbf: z.number().int().optional(),
  /** Present on personal access tokens; checked against the revocation list. */
  jti: z.string().min(1).optional(),
  sub: z.string().min(1),
  client_id: z.string().min(1),
  grant_id: z.string().min(1),
  project: z.string().min(1),
  /**
   * The OAuth scopes the authorization server granted (RFC 9068). They carry
   * no database access: the server owns this claim and its scopes are fixed,
   * while databases are picked per grant at consent.
   */
  scope: z.string().optional(),
  databases: DatabaseGrantsSchema,
  tenant: z.string().min(1).optional(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

export function callerFromClaims(claims: AccessTokenClaims): CallerClaims {
  return {
    sub: claims.sub,
    client_id: claims.client_id,
    grant_id: claims.grant_id,
    scopes: Object.entries(claims.databases)
      .map(([id, access]) => databaseScope(id, access))
      .sort(),
    ...(claims.tenant ? { tenant: claims.tenant } : {}),
  };
}
