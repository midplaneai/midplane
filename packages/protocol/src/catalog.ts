// The catalog snapshot a gateway sends up and the cloud hands back to the
// core: names, types, keys and comments only, never a value.

import { z } from "zod";

/** A table or column comment is cut to this many characters when read. */
export const CATALOG_COMMENT_MAX_CHARS = 500;

/** `COMMENT ON`, one line, as the gateway read it. */
const CommentSchema = z.string().min(1).max(CATALOG_COMMENT_MAX_CHARS);

export const ColumnSchema = z.strictObject({
  name: z.string().min(1),
  /** Type name as Postgres prints it, e.g. `text`, `timestamp with time zone`. */
  type: z.string().min(1),
  /** `pg_type.typcategory`: S string, N numeric, D date/time, B boolean, … */
  category: z.string().length(1),
  /** NOT NULL. Absent (never false) when the column is nullable. */
  not_null: z.literal(true).optional(),
  /** Part of the primary key. Absent (never false) otherwise. */
  primary_key: z.literal(true).optional(),
  comment: CommentSchema.optional(),
});
export type Column = z.infer<typeof ColumnSchema>;

/** A foreign key: these columns reference those, in order. */
export const ForeignKeySchema = z.strictObject({
  columns: z.array(z.string().min(1)).min(1),
  references: z.strictObject({
    schema: z.string().min(1),
    name: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
  }),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;

export const RelationKindSchema = z.enum([
  "table",
  "partitioned_table",
  "view",
  "materialized_view",
  "foreign_table",
]);
export type RelationKind = z.infer<typeof RelationKindSchema>;

export const RelationSchema = z.strictObject({
  schema: z.string().min(1),
  name: z.string().min(1),
  kind: RelationKindSchema,
  /** In attnum order. */
  columns: z.array(ColumnSchema),
  /** The defining SELECT of a view or materialized view. */
  definition: z.string().min(1).optional(),
  /** Top inheritance or partition ancestor; its masks and labels apply here. */
  parent: z
    .strictObject({ schema: z.string().min(1), name: z.string().min(1) })
    .optional(),
  comment: CommentSchema.optional(),
  /** Tables only; absent when there are none. */
  foreign_keys: z.array(ForeignKeySchema).min(1).optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

/** A function, operator or type defined outside `pg_catalog`. */
export const RoutineSchema = z.strictObject({
  schema: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["function", "operator", "type"]),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CatalogSnapshotSchema = z.strictObject({
  relations: z.array(RelationSchema),
  routines: z.array(RoutineSchema).default([]),
});
export type CatalogSnapshot = z.output<typeof CatalogSnapshotSchema>;
export type CatalogSnapshotInput = z.input<typeof CatalogSnapshotSchema>;
