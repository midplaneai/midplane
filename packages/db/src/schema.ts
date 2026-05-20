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

import { type TableAccessPolicy, type TenantScopeConfig } from "./policy.ts";

// --- Region -----------------------------------------------------------------

export const REGIONS = ["eu", "us"] as const;
export type Region = (typeof REGIONS)[number];

// --- bytea (encrypted DSN, HMAC token hashes) -------------------------------

const bytea = customType<{ data: Buffer; notNull: true; default: false }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return value;
  },
});

// --- inet (last_used_ip on mcp_tokens) --------------------------------------
//
// Postgres native inet stores both IPv4 and IPv6 with subnet semantics;
// Drizzle's pg-core kit doesn't export a builtin, so we model it as a
// customType. The driver returns inet values as canonical strings
// (e.g. "203.0.113.42", "2001:db8::1") which is what we render in the
// dashboard — no further conversion needed.

const inet = customType<{ data: string; notNull: false; default: false }>({
  dataType() {
    return "inet";
  },
});

// --- customers --------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(), // ULID
    // The Clerk organization this customer maps to. One-to-one: every
    // Midplane customer IS one Clerk org, with org members as the actors
    // who can sign in and act on its behalf. Org auto-creation is enabled
    // in the Clerk dashboard so every signed-in user has an active org —
    // currentCustomer() resolves via auth().orgId.
    clerkOrgId: text("clerk_org_id").notNull().unique(),
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
    // column existed; the UI falls back to the connection id when null.
    name: text("name"),
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
    // Per-DB tenant_scope config: { column, overrides, exempt } envelope
    // mirroring OSS 0.5.0's strict-mode parser. column=null + empty
    // overrides = tenant_scope disabled (YAML omits the block). Hot-
    // swappable on a running engine via /admin/policy (parity with
    // table_access). Column kept as `tenant_scope_mappings` for
    // continuity with 0009; the inner shape moved in 0012.
    tenantScope: jsonb("tenant_scope_mappings")
      .$type<TenantScopeConfig>()
      .notNull()
      .default(
        sql`'{"column":null,"overrides":{},"exempt":[]}'::jsonb`,
      ),
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
    // The Clerk user who triggered a cloud-driven event (e.g. POLICY_RELOADED
    // via the dashboard). Null for engine-side query events — no human is
    // in the loop. Customer/tenant scope is the org; this column adds the
    // actor identity inside that scope.
    actorClerkUserId: text("actor_clerk_user_id"),
    // Per-token audit attribution. The OSS engine stamps this on every
    // audit row from a session via the X-Midplane-Token-Id header (wired
    // by PR2 of mcp_url_auth_security). Cloud-emitted TOKEN_CREATED /
    // TOKEN_REVOKED rows stamp it directly. NULL for rows where no token
    // identity applies (engine pre-lockstep, REGION_CHANGED, etc.).
    mcpTokenId: text("mcp_token_id"),
  },
  (t) => ({
    customerTsIdx: index("audit_customer_region_ts_idx").on(
      t.customerId,
      t.region,
      t.ts.desc(),
    ),
    // Partial index (WHERE mcp_token_id IS NOT NULL) — Drizzle can't
    // express the predicate; the migration owns that detail and this
    // declaration mirrors the read-side existence so type inference and
    // the schema-shape tests see the index.
    customerTokenTsIdx: index("audit_customer_region_token_ts_idx").on(
      t.customerId,
      t.region,
      t.mcpTokenId,
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
// One row per connection the indexer has ever drained. Holds the
// bookmark (last_id) the next poll resumes from, plus customer_id
// stamped on the first successful index — once stamped, the indexer
// can keep draining even after the user deletes the underlying
// connection row, which is exactly the design requirement (audit-grade
// write-through: rows must reach Postgres regardless of what the user
// does to the connection mid-flight).
//
// Schema shape (PR2 of mcp_url_auth_security):
//   - id            synthetic ULID PK (was: plaintext mcp_token)
//   - connection_id nullable FK to connections(id) ON DELETE SET NULL.
//                   When the connection is hard-deleted, this flips to
//                   NULL; the row lingers until the indexer drains the
//                   remaining backlog and a future sweeper cleans
//                   orphan rows. Migration 0018 owns the partial unique
//                   index `indexer_cursors_connection_id_uq` keyed on
//                   `(connection_id) WHERE connection_id IS NOT NULL`
//                   — Drizzle's index DSL can't express the predicate,
//                   so the schema declaration here mirrors the column
//                   only; the migration owns the index detail.

export const indexerCursors = pgTable(
  "indexer_cursors",
  {
    id: text("id").primaryKey(), // ULID
    connectionId: text("connection_id"),
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
    connectionFk: foreignKey({
      name: "indexer_cursors_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("set null"),
    regionIdx: index("indexer_cursors_region_idx").on(t.region),
    customerIdx: index("indexer_cursors_customer_id_idx").on(t.customerId),
    // See header comment — the partial unique predicate lives in the
    // migration. This non-unique declaration is the read-side mirror so
    // typecheck + schema-shape tests see the index column.
    connectionIdx: index("indexer_cursors_connection_id_idx").on(t.connectionId),
  }),
);

// --- mcp_tokens -------------------------------------------------------------
//
// One row per agent-facing MCP token. Multi-token per connection
// (`connection_id` is the FK, NOT unique), prefix+CRC format
// (`mp_(live|test)_<32 hex>_<6 base32>` — see packages/db/src/token-format),
// HMAC-SHA256(pepper) hashing at rest (see packages/kms/src/pepper). Stores
// creator identity, optional expiry, last-used surface, and revocation
// state for the dashboard list / "show once" mint flow / audit.
//
// PR2 will wire the proxy to inject X-Midplane-Token-Id from the matched
// row and the OSS engine (lockstep) will stamp it on every audit event.
//
// The matching partial index `mcp_tokens_expires_at_idx` (`WHERE
// expires_at IS NOT NULL AND status='active'`) lives in 0017_mcp_tokens.sql
// — Drizzle's index DSL can't express the WHERE predicate, so the migration
// owns that detail. The read-side declaration below is the unindexed mirror
// so the schema-shape tests still see the column.

export const MCP_TOKEN_STATUSES = ["active", "revoked", "expired"] as const;
export type McpTokenStatus = (typeof MCP_TOKEN_STATUSES)[number];

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(), // ULID
    connectionId: text("connection_id").notNull(),
    // User-supplied label, unique within the connection. Mirrors how
    // connection_databases.name is scoped.
    name: text("name").notNull(),
    // "mp_live" or "mp_test" — the env prefix from the plaintext token,
    // copied here for dashboard rendering and scanner identification.
    prefix: text("prefix").notNull(),
    // Last 4 chars of the 32-hex entropy portion (NOT the trailing CRC).
    // Surfaced on the dashboard list so users can recognize their tokens
    // without storing plaintext.
    last4: text("last4").notNull(),
    // HMAC-SHA256(pepper, plaintext) — 32 bytes. Unique so a future
    // pepper-rotation conflict (same plaintext hashes to the same value
    // under the same kid) surfaces as a write error rather than silent
    // collision.
    tokenHash: bytea("token_hash").notNull(),
    // Kid of the pepper used to hash this row's token_hash. V1 always
    // "v1-<region>"; rotation introduces "v2-..." and the lookup tries
    // each kid in the in-memory map.
    pepperKid: text("pepper_kid").notNull(),
    // Clerk user id of the actor who minted the token. Distinct from
    // customer scope (the org) — this is the user inside that org.
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // NULL = never expires. The conditional sweeper (PR2) transitions
    // active+expired rows to status='expired' with revoked_reason='expired';
    // the runtime lookup also rejects expired tokens immediately, so the
    // sweeper is for dashboard truthfulness, not durable enforcement.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Conditionally updated by the proxy with a 5-min debounce (PR2's
    // resolveByToken). Stays NULL until the first successful use.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: inet("last_used_ip"),
    lastUsedUa: text("last_used_ua"),
    status: text("status", { enum: MCP_TOKEN_STATUSES })
      .notNull()
      .default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Free-form reason tag: 'user_action' | 'expired' | 'admin' (the
    // sweeper writes 'expired'; the API writes 'user_action').
    revokedReason: text("revoked_reason"),
  },
  (t) => ({
    connectionFk: foreignKey({
      name: "mcp_tokens_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    connectionStatusIdx: index("mcp_tokens_connection_status_idx").on(
      t.connectionId,
      t.status,
    ),
    // See header comment — the partial predicate lives in the migration.
    expiresAtIdx: index("mcp_tokens_expires_at_idx").on(t.expiresAt),
    tokenHashUq: unique("mcp_tokens_token_hash_uq").on(t.tokenHash),
    nameUq: unique("mcp_tokens_name_per_connection_uq").on(
      t.connectionId,
      t.name,
    ),
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
export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;

export { sql };
