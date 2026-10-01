// The per-database policy a bundle carries. Strict: an unknown key anywhere is a
// validation error, so a policy this version can't read is rejected whole,
// never partly applied. Defaults are the safe posture for an omitted section.

import { z } from "zod";

/** `schema.table`. Split at the first dot, so a schema name can't contain one. */
export const TableKeySchema = z
  .string()
  .regex(/^[^.]+\..+$/, 'expected a schema-qualified "schema.table" key');

export const AccessLevelSchema = z.enum(["deny", "read", "read_write"]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

/** What happens to a write class: run it, hold it for a human, or refuse it. */
export const ClassActionSchema = z.enum(["allow", "hold", "deny"]);
export type ClassAction = z.infer<typeof ClassActionSchema>;

/**
 * A column's mask. `none` marks a column as reviewed and left clear: in a
 * table with any mask entry, a column without one is fully redacted until
 * someone reviews it.
 */
export const MaskRuleSchema = z.union([
  z.enum(["none", "full-redact", "null-out", "consistent-hash"]),
  z.strictObject({
    t: z.literal("partial"),
    keepStart: z.number().int().nonnegative().default(0),
    keepEnd: z.number().int().nonnegative().default(0),
    glyph: z.string().min(1).max(8).default("•"),
  }),
  z.strictObject({
    t: z.literal("generalize"),
    granularity: z.union([
      z.enum(["year", "month", "day"]),
      z.number().int().positive(),
    ]),
  }),
  z.strictObject({
    t: z.literal("noise"),
    ratio: z.number().positive().max(1),
  }),
]);
export type MaskRule = z.infer<typeof MaskRuleSchema>;
/** A mask rule as authored, before defaults. */
export type MaskRuleInput = z.input<typeof MaskRuleSchema>;

export const DatabasePolicySchema = z.strictObject({
  /** Enforcement features the policy needs; an engine missing one refuses it. */
  requires_features: z.array(z.string().min(1)).default([]),
  table_access: z
    .strictObject({
      default: AccessLevelSchema.default("deny"),
      tables: z.record(TableKeySchema, AccessLevelSchema).default({}),
    })
    .prefault({}),
  writes: z
    .strictObject({
      /** INSERT, UPDATE and DELETE with a WHERE clause; CREATE TABLE [AS]. */
      row_changes: ClassActionSchema.default("allow"),
      /** ALTER, DROP and CREATE INDEX on tables. */
      schema_changes: ClassActionSchema.default("deny"),
    })
    .prefault({}),
  /** `schema.table` → column → mask. */
  masks: z
    .record(TableKeySchema, z.record(z.string().min(1), MaskRuleSchema))
    .default({}),
  labels: z
    .strictObject({
      /** `schema.table` → columns whose values may carry instructions. */
      untrusted_columns: z
        .record(TableKeySchema, z.array(z.string().min(1)))
        .default({}),
      /** Tables a tainted grant may not read. */
      secret_tables: z.array(TableKeySchema).default([]),
    })
    .prefault({}),
  /** Role every statement runs as (`SET LOCAL ROLE`). */
  role: z.string().min(1).optional(),
  limits: z
    .strictObject({
      statement_timeout_ms: z
        .number()
        .int()
        .min(1)
        .max(3_600_000)
        .default(30_000),
      lock_timeout_ms: z.number().int().min(1).max(3_600_000).default(5_000),
    })
    .prefault({}),
});

/** A validated policy, every default applied. */
export type DatabasePolicy = z.output<typeof DatabasePolicySchema>;
/** A policy as authored, before defaults. */
export type DatabasePolicyInput = z.input<typeof DatabasePolicySchema>;

/** Split a `schema.table` key at its first dot. */
export function splitTableKey(key: string): { schema: string; name: string } {
  const dot = key.indexOf(".");
  return { schema: key.slice(0, dot), name: key.slice(dot + 1) };
}
