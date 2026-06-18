// Error mapping helpers.
//
// AuditUnavailableError → MCP structured error (transport rethrow with code).
// Generic engine throw  → re-thrown unchanged (transport surfaces stack as
// MCP error per the SDK).

import { AuditUnavailableError } from "@midplane/engine";

export function isAuditUnavailable(err: unknown): err is AuditUnavailableError {
  return err instanceof AuditUnavailableError;
}
