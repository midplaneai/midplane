// Drizzle schema for midplane-cloud Postgres (Neon).
//
// Source-of-truth for the audit shape is the OSS engine schema:
//   /packages/engine/src/audit/schema.sql in midplaneai/midplane.
// audit_events_index mirrors that table column-for-column, plus customer_id
// (Midplane customer, distinct from tenant_id which is the customer's INTERNAL
// scope) and region (multi-region partition key — every dashboard query
// passes region so the planner partition-prunes).
//
// Region immutability + connection.region == customer.region are enforced
// by SQL constructs declared in 0001_constraints.sql, since Drizzle's TS
// schema language doesn't cleanly express triggers or RLS.

import { sql } from "drizzle-orm";
import {
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// --- Region -----------------------------------------------------------------

export const REGIONS = ["fra", "iad"] as const;
export type Region = (typeof REGIONS)[number];

// --- bytea (encrypted DSN) --------------------------------------------------

const bytea = customType<{ data: Buffer; notNull: true; default: false }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return value;
  },
});

// --- customers --------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(), // ULID
    clerkUserId: text("clerk_user_id").notNull().unique(),
    email: text("email").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Composite unique so connections can FK on (customer_id, region) and
    // mechanically guarantee the regions match.
    idRegion: unique("customers_id_region_uq").on(t.id, t.region),
  }),
);

// --- connections ------------------------------------------------------------

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(), // ULID
    customerId: text("customer_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    encryptedDsn: bytea("encrypted_dsn").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    mcpToken: text("mcp_token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    // Per-credential KMS grace tracking (10-min TTL + 60-min grace; refuse
    // new sessions after 70 minutes of KMS unreachability — see design doc
    // "KMS degradation"). Updated by the router on each successful decrypt.
    lastKmsSuccessAt: timestamp("last_kms_success_at", { withTimezone: true }),
  },
  (t) => ({
    customerRegionFk: foreignKey({
      name: "connections_customer_region_fk",
      columns: [t.customerId, t.region],
      foreignColumns: [customers.id, customers.region],
    }),
    customerIdx: index("connections_customer_id_idx").on(t.customerId),
  }),
);

// --- audit_events_index -----------------------------------------------------
//
// Mirrors OSS audit_events shape. ts is TIMESTAMPTZ here (vs INTEGER ms in
// SQLite); the indexer converts on write. CHECK on event_type is added in
// 0001_constraints.sql alongside RLS.

export const auditEventsIndex = pgTable(
  "audit_events_index",
  {
    id: text("id").primaryKey(), // ULID
    customerId: text("customer_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    queryId: text("query_id").notNull(),
    agentIdentity: text("agent_identity"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
  },
  (t) => ({
    customerTsIdx: index("audit_customer_region_ts_idx").on(
      t.customerId,
      t.region,
      t.ts.desc(),
    ),
    customerTypeTsIdx: index("audit_customer_region_type_ts_idx").on(
      t.customerId,
      t.region,
      t.eventType,
      t.ts.desc(),
    ),
    queryIdIdx: index("audit_query_id_idx").on(t.queryId),
    // Functional index on payload->>'sql_fingerprint' for ATTEMPTED rows
    // (matches OSS perf-review compound index). Created in
    // 0001_constraints.sql since Drizzle doesn't model partial expression
    // indexes cleanly.
  }),
);

// --- indexer_cursors --------------------------------------------------------
//
// One row per mcp_token the indexer has ever drained. Holds the bookmark
// (last_id) the next poll resumes from, plus customer_id stamped on the
// first successful index — once stamped, the indexer can keep draining
// even after the user deletes or rotates the underlying connection row,
// which is exactly the design requirement (audit-grade write-through:
// rows must reach Postgres regardless of what the user does to the
// connection mid-flight). Rows are deleted by the connections API on
// hard-delete to avoid orphan accumulation.

export const indexerCursors = pgTable(
  "indexer_cursors",
  {
    mcpToken: text("mcp_token").primaryKey(),
    customerId: text("customer_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    lastId: text("last_id").notNull().default(""), // ULIDs sort lex; "" precedes all real ids
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    regionIdx: index("indexer_cursors_region_idx").on(t.region),
    customerIdx: index("indexer_cursors_customer_id_idx").on(t.customerId),
  }),
);

// --- types ------------------------------------------------------------------

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type AuditEvent = typeof auditEventsIndex.$inferSelect;
export type NewAuditEvent = typeof auditEventsIndex.$inferInsert;
export type IndexerCursor = typeof indexerCursors.$inferSelect;
export type NewIndexerCursor = typeof indexerCursors.$inferInsert;

export { sql };
