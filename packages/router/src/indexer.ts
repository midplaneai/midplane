// Audit indexer — drains container SQLite into the cloud Postgres index.
//
// Runs co-located with the proxy in the regional Fly app (one indexer per
// process; ContainerRegistry is in-memory so cross-process indexing would
// need a persisted active-machines table, which V1 deliberately does not
// have — see PR #3 design notes).
//
// Per tick, for each active container in the registry:
//   1. GET <host>:<port>/audit/since/<lastId>?limit=500 with bearer.
//   2. In one Postgres txn: INSERT new rows into audit_events_index +
//      UPDATE the cursor row to last id of the batch.
//   3. If the OSS response signaled more rows pending (next_cursor != null),
//      re-poll the same container immediately so a backlog drains in the
//      same tick.
//   4. Periodically (every retentionSweepMs), DELETE rows older than the
//      24h grace window from the container — only after they are confirmed
//      indexed (id <= cursor.lastId).
//
// PR2 of mcp_url_auth_security:
//   - Cursor rows keyed on connection_id (was: plaintext mcp_token).
//     Synthetic id PK; nullable connection_id FK ON DELETE SET NULL so a
//     cursor survives connection deletion long enough to drain the
//     engine's remaining rows.
//   - mcp_token_id propagated from the OSS pull JSON (lockstep OSS 0.6.0)
//     to audit_events_index.mcp_token_id so dashboards can attribute
//     every audit row to the specific token that authorized the session.
//
// Failure modes:
//   - Postgres unreachable: leave cursor row untouched, log onError, do
//     NOT issue the container DELETE. Container's SQLite keeps growing
//     until indexer recovers — this is the design.
//   - Container 5xx / network error: log onError, skip this connection
//     this tick, retry next tick. Cursor unchanged.
//   - Container 401: indexer token rotation drift; log loudly and skip
//     — operator alert.
//   - Container 404 (route unconfigured): treat as soft skip; the OSS
//     image may not have INDEXER_TOKEN set in dev. Log once per token.

import { and, eq, lt, sql as drizzleSql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  connections,
  indexerCursors,
} from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";
import type { Db } from "./resolve.ts";
import type { ActiveContainer, ContainerRegistry } from "./spawner.ts";

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 500;
const DEFAULT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_SWEEP_MS = 60 * 60 * 1000;

export interface IndexerOptions {
  db: Db;
  registry: ContainerRegistry;
  /** Shared bearer token for GET /audit/since + DELETE /audit/before.
   *  Required — when absent, the indexer constructor throws so we fail
   *  fast at boot instead of silently never indexing anything. */
  indexerToken: string;
  /** Default 5_000 — design doc cadence. */
  tickMs?: number;
  /** Default 500. Also enforced by OSS server-side (max 1000). */
  batchLimit?: number;
  /** Default 24h. Cloud-side enforcement of "delete after Postgres ack +
   *  24h grace" per design doc. */
  retentionGraceMs?: number;
  /** Default 1h. Retention sweeps are cheap (one DELETE per container)
   *  but don't need to be tick-frequent; staleness budget is days. */
  retentionSweepMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  now?: () => number;
  onError?: (
    err: unknown,
    ctx: {
      connectionId: string;
      phase: "fetch" | "write" | "retention";
    },
  ) => void;
}

export interface ContainerAuditRow {
  id: string;
  query_id: string;
  tenant_id: string;
  /** From MCP `clientInfo.name` on the initialize handshake. The OSS
   *  caches this on the session object and stamps it on every emitted
   *  row. Null for non-MCP callers and for sessions where clientInfo was
   *  empty/missing. */
  agent_name?: string | null;
  /** From MCP `clientInfo.version`. Independent nullability from name —
   *  some MCP clients send name without version. */
  agent_version?: string | null;
  /** Free-text task description, ≤ 500 chars (OSS truncates before send). */
  agent_intent?: string | null;
  /** Channel that surfaced the intent. Order of preference at resolution
   *  time: mcp_meta → sql_comment → http_header. */
  intent_source?: "mcp_meta" | "sql_comment" | "http_header" | null;
  /** OSS-side DB name (`main`, `analytics`, …). Sent by OSS 0.2.0 when
   *  the engine runs against a YAML `databases:` block; absent on legacy
   *  single-DB containers. The cloud defaults to "main" when missing so
   *  audit rows from a 0.1.x → 0.2.x rollout window stay attributable. */
  database?: string;
  /** Per-token attribution stamped by the OSS engine (≥0.6.0) from the
   *  `X-Midplane-Token-Id` header the cloud proxy injects on every MCP
   *  request. NULL for sessions started before the lockstep upgrade,
   *  non-MCP callers, and rows where the header was missing or
   *  malformed. */
  mcp_token_id?: string | null;
  ts: number;
  event_type: "ATTEMPTED" | "DECIDED" | "EXECUTED" | "FAILED" | "POLICY_RELOADED";
  payload: Record<string, unknown>;
  schema_version: number;
}

const DEFAULT_DB_NAME_FALLBACK = "main";
const VALID_INTENT_SOURCES = new Set([
  "mcp_meta",
  "sql_comment",
  "http_header",
]);
const MAX_AGENT_INTENT_LEN = 500;

interface AuditSinceResponse {
  rows: ContainerAuditRow[];
  next_cursor: string | null;
}

// POLICY_RELOADED is emitted by the OSS engine on a successful
// POST /admin/policy hot-swap (cloud-driven via setTableAccess); it
// flows through the same audit pipeline as query events so operators
// can see when a policy change took effect.
const VALID_EVENT_TYPES = new Set([
  "ATTEMPTED",
  "DECIDED",
  "EXECUTED",
  "FAILED",
  "POLICY_RELOADED",
]);

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class Indexer {
  private readonly db: Db;
  private readonly registry: ContainerRegistry;
  private readonly indexerToken: string;
  private readonly tickMs: number;
  private readonly batchLimit: number;
  private readonly retentionGraceMs: number;
  private readonly retentionSweepMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => number;
  private readonly onError:
    | ((
        err: unknown,
        ctx: {
          connectionId: string;
          phase: "fetch" | "write" | "retention";
        },
      ) => void)
    | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retentionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRetentionAt = 0;
  /** Per-connection customer_id cache. customer_id is immutable for the
   *  lifetime of the connection (and connection lifetime > registry
   *  entry), so there's no staleness concern. */
  private readonly customerCache = new Map<
    string,
    { customerId: string; region: Region }
  >();

  constructor(opts: IndexerOptions) {
    if (!opts.indexerToken) {
      throw new Error(
        "Indexer: indexerToken is required (set INDEXER_TOKEN in env)",
      );
    }
    this.db = opts.db;
    this.registry = opts.registry;
    this.indexerToken = opts.indexerToken;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.retentionGraceMs = opts.retentionGraceMs ?? DEFAULT_RETENTION_GRACE_MS;
    this.retentionSweepMs = opts.retentionSweepMs ?? DEFAULT_RETENTION_SWEEP_MS;
    this.fetchFn = opts.fetch ?? fetch;
    this.nowFn = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retentionTimer) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  /** One full pass over all active containers. Exposed for tests; the
   *  tick loop calls this on the configured cadence. */
  async tick(): Promise<void> {
    const containers = this.registry.list();
    for (const container of containers) {
      try {
        await this.indexOne(container);
      } catch (err) {
        this.onError?.(err, {
          connectionId: container.connectionId,
          phase: "fetch",
        });
      }
    }

    if (this.nowFn() - this.lastRetentionAt >= this.retentionSweepMs) {
      this.lastRetentionAt = this.nowFn();
      for (const container of containers) {
        try {
          await this.sweepRetention(container);
        } catch (err) {
          this.onError?.(err, {
            connectionId: container.connectionId,
            phase: "retention",
          });
        }
      }
    }
  }

  private scheduleNextTick(): void {
    const t = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.timer !== null) this.scheduleNextTick();
      });
    }, this.tickMs);
    if (typeof t === "object" && t && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    this.timer = t;
  }

  private async indexOne(container: ActiveContainer): Promise<void> {
    // Prefer the cursor row's customer_id (stamped on first index). It
    // survives connection deletion via FK ON DELETE SET NULL: the row's
    // connection_id flips to NULL but customer_id stays, so backlog
    // drainage works even when the user deletes a connection 5 seconds
    // after first use. Fall back to the connections table on first
    // sighting only.
    const cursorRow = await this.loadCursorRow(container.connectionId);
    let customerId = cursorRow?.customerId;
    if (!customerId) {
      const meta = await this.resolveCustomer(container.connectionId);
      if (!meta) {
        // Truly orphaned: no cursor row AND no connection row. Skip.
        return;
      }
      customerId = meta.customerId;
    }

    let cursor = cursorRow?.lastId ?? "";
    // Drain in-tick: keep polling until next_cursor is null. Bounded by
    // the registry being a fixed-size set per process; no risk of starving
    // other containers because the OSS limit caps response size.
    for (let i = 0; i < 50; i++) {
      const resp = await this.fetchSince(container, cursor);
      if (resp.rows.length === 0) return;
      try {
        await this.writeBatch(
          container.connectionId,
          container.region,
          customerId,
          resp,
        );
      } catch (err) {
        this.onError?.(err, {
          connectionId: container.connectionId,
          phase: "write",
        });
        return;
      }
      cursor = resp.rows[resp.rows.length - 1]!.id;
      if (resp.next_cursor === null) return;
    }
  }

  private async fetchSince(
    container: ActiveContainer,
    cursor: string,
  ): Promise<AuditSinceResponse> {
    const url = `http://${container.host}:${container.port}/audit/since/${
      encodeURIComponent(cursor || "0")
    }?limit=${this.batchLimit}`;
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.indexerToken}` },
    });
    if (!res.ok) {
      throw new IndexerFetchError(
        `audit/since ${res.status} from ${container.host}:${container.port}`,
        res.status,
      );
    }
    const body = (await res.json()) as AuditSinceResponse;
    if (!Array.isArray(body.rows)) {
      throw new Error("audit/since: malformed response (no rows array)");
    }
    return body;
  }

  private async writeBatch(
    connectionId: string,
    region: Region,
    customerId: string,
    resp: AuditSinceResponse,
  ): Promise<void> {
    // Schema-invalid rows are logged but the cursor still advances past
    // them — leaving them in place would wedge the queue indefinitely on
    // any single bad row, and they're already durable in container SQLite
    // for forensic recovery. Engine-side zod validation should make this
    // path unreachable in practice; if it isn't, the onError callback is
    // the operator alert.
    const valid = resp.rows.filter(isValidAuditRow);
    const skipped = resp.rows.length - valid.length;
    if (skipped > 0) {
      this.onError?.(
        new Error(`indexer: ${skipped} audit rows failed schema validation`),
        { connectionId, phase: "write" },
      );
    }
    const lastId = resp.rows[resp.rows.length - 1]!.id;
    const indexedAt = new Date(this.nowFn());
    if (!ULID_RE.test(customerId)) {
      // customer_id is the value the RLS policy in 0001_constraints.sql
      // matches against; an unsanitized string here would let a stray
      // single-quote break the SET LOCAL statement. Connection rows
      // populate customer_id via ulid() at signup, so this should be
      // unreachable — guard anyway, fail closed.
      throw new Error(`indexer: invalid customer_id ${customerId}`);
    }

    await this.db.transaction(async (tx) => {
      // Bind RLS so the INSERT passes the audit_events_index policy after
      // 0004_force_rls. Without this, the policy's USING clause
      // (customer_id = current_setting('app.customer_id', true)) would
      // reject every insert under FORCE ROW LEVEL SECURITY.
      await tx.execute(
        drizzleSql.raw(`SET LOCAL app.customer_id = '${customerId}'`),
      );
      if (valid.length > 0) {
        await tx
          .insert(auditEventsIndex)
          .values(
            valid.map((row) => ({
              id: row.id,
              customerId,
              tenantId: row.tenant_id,
              region,
              queryId: row.query_id,
              agentName: row.agent_name ?? null,
              agentVersion: row.agent_version ?? null,
              agentIntent: row.agent_intent ?? null,
              intentSource: row.intent_source ?? null,
              // 0.2.0 OSS sends `database` per row; fall back to "main"
              // for legacy containers (or rows where the field is empty
              // string from a misconfigured engine — coerced via ||).
              database: row.database || DEFAULT_DB_NAME_FALLBACK,
              ts: new Date(row.ts),
              eventType: row.event_type,
              payload: row.payload,
              schemaVersion: row.schema_version,
              // OSS 0.6.0 lockstep: per-token attribution stamped on
              // every row from a session via X-Midplane-Token-Id. NULL
              // for pre-0.6.0 sessions and any row where the header was
              // missing/malformed at session initialize.
              mcpTokenId: row.mcp_token_id ?? null,
            })),
          )
          .onConflictDoNothing({ target: auditEventsIndex.id });
      }

      // Cursor upsert keyed on the partial unique index in 0018:
      //   UNIQUE (connection_id) WHERE connection_id IS NOT NULL.
      // Drizzle 0.38 supports `targetWhere` so the ON CONFLICT clause
      // names the predicate at the SQL boundary, matching the partial
      // index. The synthetic id is only consulted on first insert; the
      // existing row keeps its id on update. customer_id is also
      // immutable on conflict (matches the pre-PR2 indexer contract).
      const cursorId = ulid();
      await tx
        .insert(indexerCursors)
        .values({
          id: cursorId,
          connectionId,
          customerId,
          region,
          lastId,
          lastIndexedAt: indexedAt,
        })
        .onConflictDoUpdate({
          target: indexerCursors.connectionId,
          targetWhere: drizzleSql`connection_id IS NOT NULL`,
          set: {
            lastId,
            lastIndexedAt: indexedAt,
            lastError: null,
            lastErrorAt: null,
          },
        });
    });
  }

  private async loadCursorRow(
    connectionId: string,
  ): Promise<{ lastId: string; customerId: string } | null> {
    const rows = await this.db
      .select({
        lastId: indexerCursors.lastId,
        customerId: indexerCursors.customerId,
      })
      .from(indexerCursors)
      .where(eq(indexerCursors.connectionId, connectionId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async sweepRetention(container: ActiveContainer): Promise<void> {
    // Retention reads customer_id off the cursor row — no fallback to
    // connections needed because the cursor row is always populated by
    // the time any rows are ack'd into Postgres (writeBatch upserts it).
    const cursorRow = await this.loadCursorRow(container.connectionId);
    if (!cursorRow || !cursorRow.lastId) return;
    const customerId = cursorRow.customerId;
    const ackId = cursorRow.lastId;

    if (!ULID_RE.test(customerId)) {
      throw new Error(`indexer: invalid customer_id ${customerId}`);
    }

    // Largest id within the ack'd set that is also older than the grace
    // window. ULIDs are time-sortable, and audit_events_index also stores
    // ts as TIMESTAMPTZ, so MAX(id) WHERE ts < cutoff AND id <= ackId is
    // exact. RLS bind keeps this scoped to the cursor's customer even
    // under FORCE ROW LEVEL SECURITY (0004_force_rls).
    const cutoff = new Date(this.nowFn() - this.retentionGraceMs);
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql.raw(`SET LOCAL app.customer_id = '${customerId}'`),
      );
      return tx
        .select({ maxId: drizzleSql<string>`max(${auditEventsIndex.id})` })
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, customerId),
            lt(auditEventsIndex.ts, cutoff),
            drizzleSql`${auditEventsIndex.id} <= ${ackId}`,
          ),
        );
    });
    const deleteThrough = rows[0]?.maxId ?? null;
    if (!deleteThrough) return;

    const url = `http://${container.host}:${container.port}/audit/before/${
      encodeURIComponent(deleteThrough)
    }`;
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.indexerToken}` },
    });
    if (!res.ok) {
      throw new IndexerFetchError(
        `audit/before ${res.status} from ${container.host}:${container.port}`,
        res.status,
      );
    }
  }

  private async resolveCustomer(
    connectionId: string,
  ): Promise<{ customerId: string; region: Region } | null> {
    const cached = this.customerCache.get(connectionId);
    if (cached) return cached;
    const rows = await this.db
      .select({
        customerId: connections.customerId,
        region: connections.region,
      })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const meta = { customerId: row.customerId, region: row.region as Region };
    this.customerCache.set(connectionId, meta);
    return meta;
  }
}

class IndexerFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "IndexerFetchError";
  }
}

function isValidAuditRow(row: unknown): row is ContainerAuditRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return false;
  if (typeof r.query_id !== "string") return false;
  if (typeof r.tenant_id !== "string") return false;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return false;
  if (typeof r.event_type !== "string" || !VALID_EVENT_TYPES.has(r.event_type)) {
    return false;
  }
  if (typeof r.schema_version !== "number") return false;
  if (!r.payload || typeof r.payload !== "object" || Array.isArray(r.payload)) {
    return false;
  }
  if (!isOptionalString(r.agent_name)) return false;
  if (!isOptionalString(r.agent_version)) return false;
  if (!isOptionalString(r.agent_intent)) return false;
  // Reject over-length intent at the validation boundary so a misbehaving
  // container can't bypass the OSS-side truncation. Matches the CHECK
  // constraint installed by migration 0011 — rejecting here keeps the
  // cursor unblocked (the row is dropped, not retried forever).
  if (
    typeof r.agent_intent === "string" &&
    r.agent_intent.length > MAX_AGENT_INTENT_LEN
  ) {
    return false;
  }
  if (
    r.intent_source !== null &&
    r.intent_source !== undefined &&
    (typeof r.intent_source !== "string" ||
      !VALID_INTENT_SOURCES.has(r.intent_source))
  ) {
    return false;
  }
  // database is optional (legacy single-DB containers omit it); when
  // present it must be a non-empty string. The cloud-side fallback to
  // "main" happens at insert time, not here.
  if (
    r.database !== undefined &&
    (typeof r.database !== "string" || r.database.length === 0)
  ) {
    return false;
  }
  // mcp_token_id is optional and may be null; when present it must be a
  // non-empty string. Don't enforce ULID shape here — the FK to
  // mcp_tokens(id) is the durable enforcer; a malformed string just
  // fails the INSERT and the cursor advances past the row (matches the
  // "drop schema-invalid rows but advance cursor" posture above).
  if (
    r.mcp_token_id !== null &&
    r.mcp_token_id !== undefined &&
    (typeof r.mcp_token_id !== "string" || r.mcp_token_id.length === 0)
  ) {
    return false;
  }
  return true;
}

function isOptionalString(v: unknown): boolean {
  return v === null || v === undefined || typeof v === "string";
}

