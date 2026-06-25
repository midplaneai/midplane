// Drizzle schema for midplane-cloud Postgres (Neon).
//
// Source-of-truth for the audit shape is the OSS engine schema:
//   /packages/engine/src/audit/schema.sql in midplaneai/midplane.
// audit_events_index mirrors that table column-for-column, plus customer_id
// (Midplane customer, distinct from tenant_id which is the customer's INTERNAL
// scope) and region (multi-region partition key — every dashboard query
// passes region so the planner partition-prunes).
//
// Region immutability + project.region == customer.region are enforced
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

import {
  type ColumnMasksConfig,
  type GuardrailsConfig,
  type IgnoredColumnsConfig,
  type TableAccessPolicy,
  type TenantScopeConfig,
} from "./policy.ts";

// --- Region -----------------------------------------------------------------

export const REGIONS = ["eu", "us"] as const;
export type Region = (typeof REGIONS)[number];

// --- bytea (encrypted DSN, HMAC token hashes) -------------------------------

// notNull is FALSE at the type level so a bytea column is nullable-on-insert by
// default; columns that must be present (encrypted_dsn) opt back in with the
// builder's .notNull(). mcp_tokens.token_hash is genuinely nullable (kind='oauth'
// rows carry no HMAC), so it relies on this default.
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
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
    // The organization this customer maps to. One-to-one: every Midplane
    // customer IS one organization, with org members as the actors who can
    // sign in and act on its behalf. currentCustomer() resolves via the
    // session's active organization.
    orgId: text("org_id").notNull().unique(),
    email: text("email").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    // Founder / internal plan override. NULL = resolve normally (defer to the
    // subscription-backed `plan` below). A value forces that tier's caps and
    // BEATS the subscription — the manual upgrade lever (comp accounts, support
    // grants) that always wins in resolvePlan().
    planOverride: text("plan_override", { enum: ["free", "pro", "team"] }),
    // Subscription-backed plan: the single source of truth the Stripe webhook
    // writes (via the @better-auth/stripe subscription lifecycle hooks — see
    // apps/web/src/lib/billing.ts) and resolvePlan() reads when no planOverride
    // is set. Defaults to 'free' (no subscription). Downgrades flip this back to
    // 'free'; we never clawback already-created resources, only gate new creates.
    // TS enum only (no DB CHECK), mirroring plan_override and region.
    plan: text("plan", { enum: ["free", "pro", "team"] })
      .notNull()
      .default("free"),
    // Self-host single-owner claim. NULL until the first signup atomically
    // claims it on the implicit customer row (see lib/auth.ts). Unused in the
    // cloud (no implicit customer there) — stays NULL on every cloud row.
    ownerEmail: text("owner_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Composite unique so projects can FK on (customer_id, region) and
    // mechanically guarantee the regions match.
    idRegion: unique("customers_id_region_uq").on(t.id, t.region),
  }),
);

// --- projects ------------------------------------------------------------
//
// Parent row for an MCP project: identity, ownership, region, and the
// agent-facing token. Per-DB credential and policy state lives in the
// child table `project_databases` (one row per Postgres a single
// project can reach). Schema split landed in migration 0008.

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(), // ULID
    customerId: text("customer_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    // User-supplied label so a customer with multiple projects can tell
    // them apart in the dashboard. Nullable for rows created before this
    // column existed; the UI falls back to the project id when null.
    name: text("name"),
    // Reversible kill switch. Non-null = paused: the resolver rejects agent
    // requests with a distinct 403 (next to the mcp_tokens.status='active'
    // gate) while tokens, URLs, and policy stay intact. Clearing it restores
    // service on the next request. Cloud-only — the OSS engine is untouched.
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    customerRegionFk: foreignKey({
      name: "projects_customer_region_fk",
      columns: [t.customerId, t.region],
      foreignColumns: [customers.id, customers.region],
    }),
    customerIdx: index("projects_customer_id_idx").on(t.customerId),
  }),
);

// --- project_databases ---------------------------------------------------
//
// One row per Postgres a project can reach. The OSS 0.2.0 engine reads
// these from a YAML `databases:` block (one entry per row), each with an
// independent `table_access` policy and `tenant_scope.mappings`. The DSN
// stays encrypted at rest; KMS grace-window state (`rotated_at`,
// `last_kms_success_at`) is per-credential, not per-project — so DSN
// rotation on one DB cannot perturb the cache fence for siblings.
//
// `name` is the agent-facing alias (`main`, `analytics`, …) — what shows
// up as `database:` on the OSS tool calls. Unique within a project.

export const projectDatabases = pgTable(
  "project_databases",
  {
    id: text("id").primaryKey(), // ULID for new rows; hex for rows backfilled by 0008
    projectId: text("project_id").notNull(),
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
    // Per-DB dangerous-statement guardrails (OSS 0.9.0): categorical
    // blocks for no-WHERE DML and DDL that fire regardless of
    // table_access. Default both-on mirrors the engine's omitted-section
    // posture, so a row that predates an explicit save is protected.
    // Hot-swappable via /admin/policy alongside the other two blocks.
    guardrails: jsonb("guardrails")
      .$type<GuardrailsConfig>()
      .notNull()
      .default(
        sql`'{"block_unqualified_dml":true,"block_ddl":true}'::jsonb`,
      ),
    // Column masking (design A2): "schema.table" -> (column -> transform).
    // Empty default = no masking, the YAML omits the block. Validated by
    // validateColumnMasks on every write; serialized into the engine YAML at
    // spawn. The engine fails closed if a masked column can't be safely masked.
    columnMasks: jsonb("column_masks")
      .$type<ColumnMasksConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // PII-scan dismissals (design D1): "schema.table" -> [column…] the user
    // reviewed and marked NOT personal data, so the heuristic scan stops
    // re-flagging them. Scan-view state only — NEVER serialized into the engine
    // YAML and no respawn on change (the engine masks off column_masks alone).
    ignoredColumns: jsonb("ignored_columns")
      .$type<IgnoredColumnsConfig>()
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
    projectFk: foreignKey({
      name: "project_databases_project_fk",
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    nameUq: unique("project_databases_project_name_uq").on(
      t.projectId,
      t.name,
    ),
    projectIdx: index("project_databases_project_id_idx").on(
      t.projectId,
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
    // The user who triggered a cloud-driven event (e.g. POLICY_RELOADED via
    // the dashboard). Null for engine-side query events — no human is in the
    // loop. Customer/tenant scope is the org; this column adds the actor
    // identity inside that scope.
    actorUserId: text("actor_user_id"),
    // Per-token audit attribution. The OSS engine stamps this on every
    // audit row from a session via the X-Midplane-Token-Id header (wired
    // by PR2 of mcp_url_auth_security). Cloud-emitted TOKEN_CREATED /
    // TOKEN_REVOKED rows stamp it directly. NULL for rows where no token
    // identity applies (engine pre-lockstep, REGION_CHANGED, etc.).
    mcpTokenId: text("mcp_token_id"),
    // Cloud-only project attribution. The indexer drains each engine
    // container per-project, so the parent project id is in scope at
    // insert time (the engine itself never emits it). Lets the audit log
    // filter to one project and disambiguates same-named DBs across
    // projects (the dashboard's per-card "last query"). FK ON DELETE
    // SET NULL (mirrors indexer_cursors.project_id, 0018): audit history
    // MUST survive project deletion for compliance, so the row outlives
    // the project with project_id flipped to NULL — never CASCADE.
    // NULL on config events (no project drain), pre-0.6.0 rows, and any
    // existing row not reached by the 0020 backfill.
    projectId: text("project_id"),
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
    // Project scoping (0020). FK ON DELETE SET NULL so audit history
    // outlives project deletion (compliance) — the row's project_id
    // flips to NULL rather than the row CASCADE-deleting. Mirrors the
    // indexer_cursors → projects FK from 0018. The migration creates
    // the constraint inline (auto-named) the same way 0018 did; this
    // declaration is the read-side mirror.
    projectFk: foreignKey({
      name: "audit_events_index_project_fk",
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete("set null"),
    // Partial index (WHERE project_id IS NOT NULL) — the /audit
    // project filter always supplies a concrete id and never scans the
    // NULL bucket (config events + pre-backfill rows), so the predicate
    // keeps the index small. Mirrors the agent_name / mcp_token_id partial
    // indexes; Drizzle can't express the WHERE, so the migration owns it
    // and this declaration is the read-side mirror.
    customerProjectTsIdx: index(
      "audit_customer_region_project_ts_idx",
    ).on(t.customerId, t.region, t.projectId, t.ts.desc()),
    // Functional index on payload->>'sql_fingerprint' for ATTEMPTED rows
    // (matches OSS perf-review compound index). Created in
    // 0001_constraints.sql since Drizzle doesn't model partial expression
    // indexes cleanly.
  }),
);

// --- indexer_cursors --------------------------------------------------------
//
// One row per project the indexer has ever drained. Holds the
// bookmark (last_id) the next poll resumes from, plus customer_id
// stamped on the first successful index — once stamped, the indexer
// can keep draining even after the user deletes the underlying
// project row, which is exactly the design requirement (audit-grade
// write-through: rows must reach Postgres regardless of what the user
// does to the project mid-flight).
//
// Schema shape (PR2 of mcp_url_auth_security):
//   - id            synthetic ULID PK (was: plaintext mcp_token)
//   - project_id nullable FK to projects(id) ON DELETE SET NULL.
//                   When the project is hard-deleted, this flips to
//                   NULL; the row lingers until the indexer drains the
//                   remaining backlog and a future sweeper cleans
//                   orphan rows. Migration 0018 owns the partial unique
//                   index `indexer_cursors_project_id_uq` keyed on
//                   `(project_id) WHERE project_id IS NOT NULL`
//                   — Drizzle's index DSL can't express the predicate,
//                   so the schema declaration here mirrors the column
//                   only; the migration owns the index detail.

export const indexerCursors = pgTable(
  "indexer_cursors",
  {
    id: text("id").primaryKey(), // ULID
    projectId: text("project_id"),
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
    projectFk: foreignKey({
      name: "indexer_cursors_project_fk",
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete("set null"),
    regionIdx: index("indexer_cursors_region_idx").on(t.region),
    customerIdx: index("indexer_cursors_customer_id_idx").on(t.customerId),
    // See header comment — the partial unique predicate lives in the
    // migration. This non-unique declaration is the read-side mirror so
    // typecheck + schema-shape tests see the index column.
    projectIdx: index("indexer_cursors_project_id_idx").on(t.projectId),
  }),
);

// --- mcp_tokens -------------------------------------------------------------
//
// One row per agent-facing MCP token. Multi-token per project
// (`project_id` is the FK, NOT unique), prefix+CRC format
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

// How a token authenticates the agent. 'url' is the HMAC plaintext-URL token
// (the show-once `mp_(live|test)_…` bearer). 'oauth' is an attribution-only row
// minted per (project, OAuth client) by the MCP-OAuth path (0026): it carries
// no HMAC secret (token_hash/pepper_kid are NULL) and never resolves via the URL
// proxy, but its id is what the engine stamps as mcp_token_id so per-agent audit
// attribution survives the URL→OAuth switch. See lib/proxy.ts proxyMcpOAuth.
export const MCP_TOKEN_KINDS = ["url", "oauth"] as const;
export type McpTokenKind = (typeof MCP_TOKEN_KINDS)[number];

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(), // ULID
    projectId: text("project_id").notNull(),
    // User-supplied label, unique within the project. Mirrors how
    // project_databases.name is scoped. OAuth rows use `oauth:<clientId>`.
    name: text("name").notNull(),
    // "mp_live" or "mp_test" — the env prefix from the plaintext token,
    // copied here for dashboard rendering and scanner identification.
    // OAuth attribution rows carry the sentinel 'mp_oauth'.
    prefix: text("prefix").notNull(),
    // Last 4 chars of the 32-hex entropy portion (NOT the trailing CRC).
    // Surfaced on the dashboard list so users can recognize their tokens
    // without storing plaintext. OAuth rows carry the last 4 of the client id.
    last4: text("last4").notNull(),
    // HMAC-SHA256(pepper, plaintext) — 32 bytes. Unique so a future
    // pepper-rotation conflict (same plaintext hashes to the same value
    // under the same kid) surfaces as a write error rather than silent
    // collision. NULL for kind='oauth' rows (no plaintext secret); Postgres
    // unique allows many NULLs, and a NULL hash never matches the proxy lookup.
    tokenHash: bytea("token_hash"),
    // Kid of the pepper used to hash this row's token_hash. V1 always
    // "v1-<region>"; rotation introduces "v2-..." and the lookup tries
    // each kid in the in-memory map. NULL for kind='oauth' rows.
    pepperKid: text("pepper_kid"),
    // Auth mechanism (0026). Defaults to 'url' so every pre-OAuth row is the
    // HMAC URL token unchanged. 'oauth' marks the attribution-only rows the
    // MCP-OAuth path mints; they're excluded from plan-cap counts, the
    // dashboard token list, and the URL resolver.
    kind: text("kind", { enum: MCP_TOKEN_KINDS }).notNull().default("url"),
    // OAuth client (oauth_application.client_id) this attribution row belongs
    // to. NULL for kind='url'. The (project_id, client_id) partial-unique
    // index (migration 0026) is what makes the mint-or-get idempotent.
    clientId: text("client_id"),
    // User id of the actor who minted the token. Distinct from customer scope
    // (the org) — this is the user inside that org.
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
    projectFk: foreignKey({
      name: "mcp_tokens_project_fk",
      columns: [t.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    projectStatusIdx: index("mcp_tokens_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    // See header comment — the partial predicate lives in the migration.
    expiresAtIdx: index("mcp_tokens_expires_at_idx").on(t.expiresAt),
    // Read-side mirror of the UNIQUE PARTIAL index (WHERE kind='oauth') the
    // 0026 migration owns — Drizzle can't express the predicate. It's what
    // makes "mint-or-get one attribution row per (project, OAuth client)"
    // race-safe; the uniqueness is enforced by the migration's index, not this
    // declaration.
    oauthClientIdx: index("mcp_tokens_oauth_client_idx").on(
      t.projectId,
      t.clientId,
    ),
    tokenHashUq: unique("mcp_tokens_token_hash_uq").on(t.tokenHash),
    nameUq: unique("mcp_tokens_name_per_project_uq").on(
      t.projectId,
      t.name,
    ),
  }),
);

// --- mcp_scope_grants -------------------------------------------------------
//
// Per-agent least-privilege DB scope (P6.1). The access boundary ON TOP of
// ownership: which project_databases an agent may reach and at what access.
// The proxy resolves the grant set for a credential, intersects it with the
// project's DBs, and injects the X-Midplane-Scope session header the engine
// enforces (subset gate + clamp read_write→read where the grant is read).
// Absence of a row = that DB is NOT in the agent's scope.
//
// ONE table, polymorphic subject, so OAuth and headless PAT credentials share
// one enforcement path. Exactly one subject is set per row (DB CHECK in 0028):
//   - OAuth: (client_id, user_id), written at consent;
//   - PAT:   mcp_token_id, written at token creation.
// Keyed by project_database_id (stable spawn/DSN/audit id; survives rename).
// No RLS (mirrors mcp_tokens) — ownership is enforced in app code. The two
// partial UNIQUE indexes (one OAuth, one PAT) live in the 0028 migration since
// Drizzle can't express the WHERE predicate; the declarations below are the
// unindexed read-side mirror so type inference + schema-shape tests see them.

export const MCP_SCOPE_ACCESS_LEVELS = ["read", "write"] as const;
export type McpScopeAccess = (typeof MCP_SCOPE_ACCESS_LEVELS)[number];

export const mcpScopeGrants = pgTable(
  "mcp_scope_grants",
  {
    id: text("id").primaryKey(), // ULID
    projectDatabaseId: text("project_database_id").notNull(),
    // OAuth subject (client_id = oauth_application.client_id, user_id =
    // user.id). NULL for PAT grants. FKs to the auth tables live in the
    // migration (cross-module, same as mcp_tokens.client_id).
    clientId: text("client_id"),
    userId: text("user_id"),
    // Headless PAT subject. NULL for OAuth grants.
    mcpTokenId: text("mcp_token_id"),
    access: text("access", { enum: MCP_SCOPE_ACCESS_LEVELS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    projectDatabaseFk: foreignKey({
      name: "mcp_scope_grants_project_database_fk",
      columns: [t.projectDatabaseId],
      foreignColumns: [projectDatabases.id],
    }).onDelete("cascade"),
    // Read-side mirrors of the UNIQUE PARTIAL indexes the 0028 migration owns
    // (WHERE mcp_token_id IS NULL / IS NOT NULL — not expressible in Drizzle).
    // The (client_id, user_id) / (mcp_token_id) prefixes also serve the proxy's
    // per-request grant lookup.
    oauthIdx: index("mcp_scope_grants_oauth_uq").on(
      t.clientId,
      t.userId,
      t.projectDatabaseId,
    ),
    patIdx: index("mcp_scope_grants_pat_uq").on(
      t.mcpTokenId,
      t.projectDatabaseId,
    ),
    cdbIdx: index("mcp_scope_grants_cdb_idx").on(t.projectDatabaseId),
  }),
);

// --- types ------------------------------------------------------------------

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectDatabase = typeof projectDatabases.$inferSelect;
export type NewProjectDatabase = typeof projectDatabases.$inferInsert;
export type AuditEvent = typeof auditEventsIndex.$inferSelect;
export type NewAuditEvent = typeof auditEventsIndex.$inferInsert;
export type IndexerCursor = typeof indexerCursors.$inferSelect;
export type NewIndexerCursor = typeof indexerCursors.$inferInsert;
export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;
export type McpScopeGrant = typeof mcpScopeGrants.$inferSelect;
export type NewMcpScopeGrant = typeof mcpScopeGrants.$inferInsert;

export { sql };
