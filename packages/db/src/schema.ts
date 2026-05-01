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

import { type TableAccessPolicy } from "./policy.ts";

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
//
// Parent row for an MCP connection: identity, ownership, region, and the
// agent-facing token. Per-DB credential and policy state lives in the
// child table `connection_databases` (one row per Postgres a single
// connection can reach). Schema split landed in migration 0008.

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(), // ULID
    customerId: text("customer_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    // User-supplied label so a customer with multiple connections can tell
    // them apart in the dashboard. Nullable for rows created before this
    // column existed; the UI falls back to the MCP URL when null.
    name: text("name"),
    mcpToken: text("mcp_token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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

// --- connection_databases ---------------------------------------------------
//
// One row per Postgres a connection can reach. The OSS 0.2.0 engine reads
// these from a YAML `databases:` block (one entry per row), each with an
// independent `table_access` policy and `tenant_scope.mappings`. The DSN
// stays encrypted at rest; KMS grace-window state (`rotated_at`,
// `last_kms_success_at`) is per-credential, not per-connection — so DSN
// rotation on one DB cannot perturb the cache fence for siblings.
//
// `name` is the agent-facing alias (`main`, `analytics`, …) — what shows
// up as `database:` on the OSS tool calls. Unique within a connection.

export const connectionDatabases = pgTable(
  "connection_databases",
  {
    id: text("id").primaryKey(), // ULID for new rows; hex for rows backfilled by 0008
    connectionId: text("connection_id").notNull(),
    // Agent-facing alias. ^[a-z][a-z0-9_-]{0,31}$ — matches OSS DB_NAME_RE
    // exactly so a name validated here also passes OSS-side parsing.
    name: text("name").notNull(),
    encryptedDsn: bytea("encrypted_dsn").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    // Per-DB table_access policy. Materialized into the YAML `databases[]`
    // entry at spawn time. Default (`deny` everywhere) preserves existing
    // behavior for rows created without an explicit policy — identical to
    // the engine's no-YAML default.
    tableAccess: jsonb("table_access")
      .$type<TableAccessPolicy>()
      .notNull()
      .default(sql`'{"default":"deny","tables":{}}'::jsonb`),
    // Per-DB tenant_scope mappings: column name → tenant_id column. Empty
    // map = tenant_scope disabled for this DB. Editing forces a container
    // restart per OSS spec (mappings hot-swap is rejected).
    tenantScopeMappings: jsonb("tenant_scope_mappings")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    // Per-credential KMS grace tracking (10-min TTL + 60-min grace; refuse
    // new sessions after 70 minutes of KMS unreachability — see design doc
    // "KMS degradation"). Updated by the router on each successful decrypt.
    lastKmsSuccessAt: timestamp("last_kms_success_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    connectionFk: foreignKey({
      name: "connection_databases_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    nameUq: unique("connection_databases_connection_name_uq").on(
      t.connectionId,
      t.name,
    ),
    connectionIdx: index("connection_databases_connection_id_idx").on(
      t.connectionId,
    ),
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
    // DEPRECATED — column kept on the table for one rollout window so that
    // an in-flight pre-bump indexer (still issuing INSERTs that name
    // agent_identity) doesn't hit "column does not exist" mid-deploy.
    // OSS 0.3.0 stopped emitting it; the new indexer doesn't write it.
    // Drop column + this field together in a follow-up migration once the
    // app rollout is fully cut over and no old process can target the
    // column. Reads should always prefer agentName.
    agentIdentity: text("agent_identity"),
    // From MCP `clientInfo` on the initialize handshake, stamped per
    // session by the OSS engine and copied to every audit row from that
    // session. Split from version so the dashboard can group across
    // versions ("everything claude-code did") and filter by version.
    agentName: text("agent_name"),
    agentVersion: text("agent_version"),
    // Free-text task description the agent declared for this query.
    // Resolved by the OSS in priority order: MCP `_meta.intent` →
    // SQL comment hint (`/* midplane:intent="..." */`) → HTTP header
    // (`X-Midplane-Intent`). Truncated to 500 chars at emission.
    agentIntent: text("agent_intent"),
    // Which channel surfaced the intent. Lets the UI distinguish
    // first-class _meta.intent from best-effort fallbacks and surface
    // signal richness over time. NULL when no intent was provided.
    intentSource: text("intent_source", {
      enum: ["mcp_meta", "sql_comment", "http_header"] as const,
    }),
    // OSS-side database name (`main`, `analytics`, …). Multi-DB rollout in
    // 0009; defaults to 'main' for legacy single-DB containers and any
    // pre-0.2.0 row that omits the field on the audit pull payload.
    database: text("database").notNull().default("main"),
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
    customerDatabaseTsIdx: index("audit_customer_region_database_ts_idx").on(
      t.customerId,
      t.region,
      t.database,
      t.ts.desc(),
    ),
    // Partial index keyed on agent_name; declared here so the schema view
    // matches what 0011 created. The `WHERE agent_name IS NOT NULL`
    // predicate can't be expressed in Drizzle's index DSL — the migration
    // owns that detail and this declaration is the read-side mirror.
    customerAgentTsIdx: index("audit_customer_region_agent_ts_idx").on(
      t.customerId,
      t.region,
      t.agentName,
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
export type ConnectionDatabase = typeof connectionDatabases.$inferSelect;
export type NewConnectionDatabase = typeof connectionDatabases.$inferInsert;
export type AuditEvent = typeof auditEventsIndex.$inferSelect;
export type NewAuditEvent = typeof auditEventsIndex.$inferInsert;
export type IndexerCursor = typeof indexerCursors.$inferSelect;
export type NewIndexerCursor = typeof indexerCursors.$inferInsert;

export { sql };
