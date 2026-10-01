// Names shared by verdicts, audit events and the dashboard.

import { z } from "zod";

/** The rule behind a denial. Every denial names exactly one. */
export const RuleIdSchema = z.enum([
  "parse_error",
  "multi_statement",
  "unsupported",
  "unresolved",
  "scope",
  "table_access",
  "hidden_write",
  "where_required",
  "write_class",
  "dangerous_function",
  "mask",
  "containment",
]);
export type RuleId = z.infer<typeof RuleIdSchema>;

/** The class a write is held or refused by. */
export const ApprovalClassSchema = z.enum(["row_changes", "schema_changes"]);
export type ApprovalClass = z.infer<typeof ApprovalClassSchema>;

/**
 * Why a write is held: its class is held by the policy, or only the grant's
 * taint holds it (the class would allow it).
 */
export const HoldCauseSchema = z.enum(["class", "taint"]);
export type HoldCause = z.infer<typeof HoldCauseSchema>;
