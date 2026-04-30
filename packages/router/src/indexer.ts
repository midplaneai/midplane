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
// Failure modes:
//   - Postgres unreachable: leave cursor row untouched, log onError, do
//     NOT issue the container DELETE. Container's SQLite keeps growing
//     until indexer recovers — this is the design.
//   - Container 5xx / network error: log onError, skip this token this
//     tick, retry next tick. Cursor unchanged.
//   - Container 401: token rotation drift on cloud side; log loudly and
//     skip — operator alert.
//   - Container 404 (route unconfigured): treat as soft skip; the OSS
//     image may not have INDEXER_TOKEN set in dev. Log once per token.

import { and, eq, lt, sql as drizzleSql } from "drizzle-orm";
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
    ctx: { token: string; phase: "fetch" | "write" | "retention" },
  ) => void;
}

export interface ContainerAuditRow {
  id: string;
  query_id: string;
  tenant_id: string;
  agent_identity: string | null;
  ts: number;
  event_type: "ATTEMPTED" | "DECIDED" | "EXECUTED" | "FAILED";
  payload: Record<string, unknown>;
  schema_version: number;
}

interface AuditSinceResponse {
  rows: ContainerAuditRow[];
  next_cursor: string | null;
}

const VALID_EVENT_TYPES = new Set([
  "ATTEMPTED",
  "DECIDED",
  "EXECUTED",
  "FAILED",
]);

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
    | ((err: unknown, ctx: { token: string; phase: "fetch" | "write" | "retention" }) => void)
    | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retentionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRetentionAt = 0;
  /** Per-token customer_id cache. Customer_id is immutable for the
   *  lifetime of the connection (and connection lifetime > registry entry),
   *  so there's no staleness concern. */
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
        this.onError?.(err, { token: container.token, phase: "fetch" });
      }
    }

    if (this.nowFn() - this.lastRetentionAt >= this.retentionSweepMs) {
      this.lastRetentionAt = this.nowFn();
      for (const container of containers) {
        try {
          await this.sweepRetention(container);
        } catch (err) {
          this.onError?.(err, { token: container.token, phase: "retention" });
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
    const meta = await this.resolveCustomer(container.token);
    if (!meta) {
      // Token not in connections — orphaned container or token race; skip.
      return;
    }

    let cursor = await this.loadCursor(container.token, container.region);
    // Drain in-tick: keep polling until next_cursor is null. Bounded by
    // the registry being a fixed-size set per process; no risk of starving
    // other containers because the OSS limit caps response size.
    for (let i = 0; i < 50; i++) {
      const resp = await this.fetchSince(container, cursor);
      if (resp.rows.length === 0) return;
      try {
        await this.writeBatch(container.token, container.region, meta.customerId, resp);
      } catch (err) {
        this.onError?.(err, { token: container.token, phase: "write" });
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
    token: string,
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
        { token, phase: "write" },
      );
    }
    const lastId = resp.rows[resp.rows.length - 1]!.id;
    const indexedAt = new Date(this.nowFn());

    await this.db.transaction(async (tx) => {
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
              agentIdentity: row.agent_identity,
              ts: new Date(row.ts),
              eventType: row.event_type,
              payload: row.payload,
              schemaVersion: row.schema_version,
            })),
          )
          .onConflictDoNothing({ target: auditEventsIndex.id });
      }

      await tx
        .insert(indexerCursors)
        .values({
          mcpToken: token,
          region,
          lastId,
          lastIndexedAt: indexedAt,
        })
        .onConflictDoUpdate({
          target: indexerCursors.mcpToken,
          set: {
            lastId,
            lastIndexedAt: indexedAt,
            lastError: null,
            lastErrorAt: null,
          },
        });
    });
  }

  private async loadCursor(token: string, region: Region): Promise<string> {
    const rows = await this.db
      .select({ lastId: indexerCursors.lastId })
      .from(indexerCursors)
      .where(eq(indexerCursors.mcpToken, token))
      .limit(1);
    if (rows[0]) return rows[0].lastId;
    // First sighting — seed the row at empty cursor so the staleness
    // probe (MAX(last_indexed_at)) sees the container immediately.
    await this.db
      .insert(indexerCursors)
      .values({ mcpToken: token, region, lastId: "" })
      .onConflictDoNothing();
    return "";
  }

  private async sweepRetention(container: ActiveContainer): Promise<void> {
    const meta = await this.resolveCustomer(container.token);
    if (!meta) return;

    const cursorRows = await this.db
      .select({ lastId: indexerCursors.lastId })
      .from(indexerCursors)
      .where(eq(indexerCursors.mcpToken, container.token))
      .limit(1);
    const ackId = cursorRows[0]?.lastId;
    if (!ackId) return;

    // Largest id within the ack'd set that is also older than the grace
    // window. ULIDs are time-sortable, and audit_events_index also stores
    // ts as TIMESTAMPTZ, so MAX(id) WHERE ts < cutoff AND id <= ackId is
    // exact. Customer scoping keeps RLS effective even from this path.
    const cutoff = new Date(this.nowFn() - this.retentionGraceMs);
    const rows = await this.db
      .select({ maxId: drizzleSql<string>`max(${auditEventsIndex.id})` })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, meta.customerId),
          lt(auditEventsIndex.ts, cutoff),
          drizzleSql`${auditEventsIndex.id} <= ${ackId}`,
        ),
      );
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
    token: string,
  ): Promise<{ customerId: string; region: Region } | null> {
    const cached = this.customerCache.get(token);
    if (cached) return cached;
    const rows = await this.db
      .select({
        customerId: connections.customerId,
        region: connections.region,
      })
      .from(connections)
      .where(eq(connections.mcpToken, token))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const meta = { customerId: row.customerId, region: row.region as Region };
    this.customerCache.set(token, meta);
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
  if (
    r.agent_identity !== null &&
    r.agent_identity !== undefined &&
    typeof r.agent_identity !== "string"
  ) {
    return false;
  }
  return true;
}

