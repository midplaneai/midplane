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

import { and, eq, inArray, lt, sql as drizzleSql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  connections,
  indexerCursors,
  mcpTokens,
} from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";
import type { Db } from "./resolve.ts";
import type { ActiveContainer, ContainerRegistry } from "./spawner.ts";

const DEFAULT_TICK_MS = 5_000;
/** recordError write throttle — minute-level is plenty for the
 *  freshness dot; without it a persistently-down engine churns an
 *  indexer_cursors UPDATE every tick. */
const ERROR_STAMP_MIN_MS = 60_000;
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
  /** Per-connection synthetic cursor id. Populated on first cursor hit
   *  (or first writeBatch upsert) and used afterwards for all reads and
   *  writes on that cursor — by id, never by connection_id. This is what
   *  preserves the drain-after-delete promise: ON DELETE SET NULL on the
   *  indexer_cursors → connections FK flips the cursor's connection_id
   *  to NULL, so any WHERE connection_id = $1 query misses. The synthetic
   *  id is stable; re-INSERTing with the (now-dangling) connection_id
   *  would also violate the FK. Process-local — on restart, undrained
   *  orphan cursors are unrecoverable (same limitation the in-memory
   *  ContainerRegistry has had since day one). */
  private readonly cursorIdByConnectionId = new Map<string, string>();

  /** Last time recordError stamped a row, per connection — write
   *  throttle so a persistently-down engine doesn't churn
   *  indexer_cursors every tick (see recordError). */
  private readonly lastErrorStampMs = new Map<string, number>();

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
        await this.recordError(container, err);
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
        await this.recordError(container, err);
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

    // FK guard for audit_events_index.mcp_token_id (FK ON DELETE SET
    // NULL on existing rows; INSERTs still fail if the referenced
    // mcp_tokens row is gone). When a customer deletes a connection
    // while the OSS container still has backlog rows in its SQLite, the
    // CASCADE through connections → mcp_tokens has already fired by the
    // time the indexer drains those rows. INSERTing them with the
    // (now-dangling) mcp_token_id would violate
    // audit_events_index_mcp_token_id_fk and roll back the whole batch.
    //
    // Probe the still-extant token ids referenced in this batch and
    // NULL out the rest before the insert. One extra round trip per
    // batch in the steady state where every referenced token is still
    // live; the alternative (catch FK and retry without the column) is
    // both more code and would mask other FK failures.
    const referencedTokenIds = Array.from(
      new Set(
        valid
          .map((r) => r.mcp_token_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    let extantTokenIds = new Set<string>();
    if (referencedTokenIds.length > 0) {
      const tokenRows = await this.db
        .select({ id: mcpTokens.id })
        .from(mcpTokens)
        .where(inArray(mcpTokens.id, referencedTokenIds));
      extantTokenIds = new Set(tokenRows.map((r) => r.id));
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
              // for pre-0.6.0 sessions, rows where the header was
              // missing/malformed at session initialize, and the
              // post-connection-delete case where the referenced
              // mcp_tokens row has been CASCADE-deleted (see FK guard
              // above).
              mcpTokenId:
                row.mcp_token_id && extantTokenIds.has(row.mcp_token_id)
                  ? row.mcp_token_id
                  : null,
            })),
          )
          .onConflictDoNothing({ target: auditEventsIndex.id });
      }

      // Cursor write. Two paths:
      //
      // (a) cached cursor id → UPDATE by id. Stable across ON DELETE SET
      //     NULL flipping the cursor's connection_id to NULL. Without
      //     this branch, the upsert below would try to re-INSERT a row
      //     carrying the now-deleted connection_id and trip the FK.
      //
      // (b) no cache yet → INSERT with full row + connection_id (which
      //     still exists at first sighting since the container is
      //     running; the connections row hasn't been deleted yet). ON
      //     CONFLICT on the partial unique index updates the existing
      //     row. After the upsert, look up the row's synthetic id to
      //     stamp the cache for subsequent ticks.
      const cachedCursorId = this.cursorIdByConnectionId.get(connectionId);
      if (cachedCursorId) {
        await tx
          .update(indexerCursors)
          .set({
            lastId,
            lastIndexedAt: indexedAt,
            lastError: null,
            lastErrorAt: null,
          })
          .where(eq(indexerCursors.id, cachedCursorId));
      } else {
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
        // ON CONFLICT doesn't return the existing row, so look it up to
        // get the real id (which may be the just-inserted cursorId on a
        // clean insert, or the pre-existing id on conflict).
        const stamped = await tx
          .select({ id: indexerCursors.id })
          .from(indexerCursors)
          .where(eq(indexerCursors.connectionId, connectionId))
          .limit(1);
        if (stamped[0]) {
          this.cursorIdByConnectionId.set(connectionId, stamped[0].id);
        }
      }
    });

    // Successful drain clears the error stamps in the DB — clear the
    // recordError throttle too, so a fail→recover→fail-again sequence
    // inside ERROR_STAMP_MIN_MS stamps the NEW outage immediately
    // instead of staying green for up to a minute (codex review P2).
    this.lastErrorStampMs.delete(connectionId);
  }

  /** Best-effort: stamp last_error / last_error_at on the connection's
   *  cursor row so the dashboard freshness dot can actually go red —
   *  computeFreshness returns "down" only when last_error_at is newer
   *  than last_indexed_at. Before this, drain errors only reached the
   *  onError callback and the dot stayed green no matter how broken the
   *  engine was.
   *
   *  Never throws: it runs inside catch blocks, and a recording failure
   *  must not mask or amplify the original error. Two paths, mirroring
   *  the cursor write in writeBatch:
   *    (a) cursor row exists → UPDATE by synthetic id (stable across the
   *        FK ON DELETE SET NULL flip).
   *    (b) no row yet (engine erroring since first sighting) → INSERT
   *        with customer_id resolved from connections; if that row is
   *        already gone the cursor is truly orphaned and there is
   *        nothing for the dashboard to paint — skip.
   */
  private async recordError(
    container: ActiveContainer,
    err: unknown,
  ): Promise<void> {
    try {
      // Throttle: a persistently-down engine fails every 5s tick; the
      // freshness dot only needs minute-level granularity, so don't
      // churn an UPDATE (plus the cursor lookup) on indexer_cursors
      // every tick indefinitely.
      const nowMs = this.nowFn();
      const lastStamp = this.lastErrorStampMs.get(container.connectionId);
      if (lastStamp !== undefined && nowMs - lastStamp < ERROR_STAMP_MIN_MS) {
        return;
      }
      this.lastErrorStampMs.set(container.connectionId, nowMs);

      const message = (err instanceof Error ? err.message : String(err)).slice(
        0,
        1000,
      );
      const errorAt = new Date(nowMs);

      // loadCursorRow populates cursorIdByConnectionId as a side effect.
      await this.loadCursorRow(container.connectionId);
      const cachedCursorId = this.cursorIdByConnectionId.get(
        container.connectionId,
      );
      if (cachedCursorId) {
        await this.db
          .update(indexerCursors)
          .set({ lastError: message, lastErrorAt: errorAt })
          .where(eq(indexerCursors.id, cachedCursorId));
        return;
      }

      const meta = await this.resolveCustomer(container.connectionId);
      if (!meta) return;
      await this.db
        .insert(indexerCursors)
        .values({
          id: ulid(),
          connectionId: container.connectionId,
          customerId: meta.customerId,
          region: container.region,
          lastError: message,
          lastErrorAt: errorAt,
        })
        .onConflictDoUpdate({
          target: indexerCursors.connectionId,
          targetWhere: drizzleSql`connection_id IS NOT NULL`,
          set: { lastError: message, lastErrorAt: errorAt },
        });
    } catch {
      // Recording is diagnostics, not correctness — swallow. The
      // original error already reached onError above.
    }
  }

  private async loadCursorRow(
    connectionId: string,
  ): Promise<{ lastId: string; customerId: string } | null> {
    // Consult the in-memory cache first: once we know the cursor's
    // synthetic id, the lookup is stable even after the connection FK
    // sets connection_id to NULL. A stale cache (e.g., the orphan-cursor
    // sweeper deleted the row out from under us) drops the entry and
    // falls through to the connection_id query — at which point we'll
    // also miss and the caller treats this as no-cursor-yet (which is
    // correct: the row is gone).
    const cachedCursorId = this.cursorIdByConnectionId.get(connectionId);
    if (cachedCursorId) {
      const rows = await this.db
        .select({
          lastId: indexerCursors.lastId,
          customerId: indexerCursors.customerId,
        })
        .from(indexerCursors)
        .where(eq(indexerCursors.id, cachedCursorId))
        .limit(1);
      if (rows[0]) return rows[0];
      this.cursorIdByConnectionId.delete(connectionId);
    }

    const rows = await this.db
      .select({
        id: indexerCursors.id,
        lastId: indexerCursors.lastId,
        customerId: indexerCursors.customerId,
      })
      .from(indexerCursors)
      .where(eq(indexerCursors.connectionId, connectionId))
      .limit(1);
    if (!rows[0]) return null;
    this.cursorIdByConnectionId.set(connectionId, rows[0].id);
    return { lastId: rows[0].lastId, customerId: rows[0].customerId };
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

