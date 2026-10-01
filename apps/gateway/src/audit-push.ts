// The audit push: a linked gateway sends each event of its audit file to
// Midplane Cloud as a record, after the event is durable, on a loop of its
// own. Pushing never gates a statement (invariant 2): `append` only wakes
// this loop, which reads what is already on disk.
//
// A record is a projection with no result values and no Postgres message.
// Its statement goes with every literal replaced and every name the
// catalog doesn't know replaced, or with no text when that can't be
// vouched for. Only while the newest authentic bundle names the database in
// `audit.full_text` does the statement go as written, with the agent's
// intent and a denial's reason.
//
// Events are marked acked only on a signed ack naming one this batch
// carried; anything else leaves them owed, and they go again. A signed ack
// naming a conflict, an event the cloud holds under another hash at one of
// the batch's sequences, means the file forked from what the cloud holds (a
// restored backup, a copy): the events before it are acked, and the rest go
// on as a new instance.

import {
  catalogNames,
  type RedactedStatement,
  redactStatement,
} from "@midplane/core";
import {
  AUDIT_BATCH_MAX,
  AUDIT_FIELD_MAX,
  AUDIT_KINDS_MAX,
  AUDIT_TABLES_MAX,
  AUDIT_TEXT_MAX,
  type AuditBatch,
  type AuditEvent,
  AuditEventSchema,
  type AuditRecord,
  AuditRecordSchema,
  type CatalogSnapshot,
} from "@midplane/protocol";
import type { AuditRow, LocalAuditLog } from "./audit.ts";
import type { Logger } from "./log.ts";

/** A batch stops growing past this many bytes of JSON. */
const BATCH_TARGET_BYTES = 1024 * 1024;

/** Cut text to `max` UTF-16 units without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}

export interface ProjectionContext {
  /** Whether this database's statements go up as written (the bundle's switch). */
  fullText(database: string): boolean;
  /** The database's catalog, for the names a redacted statement may keep. */
  catalog(database: string): CatalogSnapshot | null;
  /** The ATTEMPTED of a query, for the database a later event belongs to. */
  attempted(
    queryId: string,
  ): Extract<AuditEvent, { event: "ATTEMPTED" }> | null;
  /** An event's hash as the cloud may see it: keyed with the file's secret. */
  checkpoint(hash: string): string;
}

const namesCache = new WeakMap<CatalogSnapshot, Set<string>>();

function namesOf(catalog: CatalogSnapshot | null): Set<string> | undefined {
  if (!catalog) return undefined;
  let names = namesCache.get(catalog);
  if (!names) {
    names = catalogNames(catalog);
    namesCache.set(catalog, names);
  }
  return names;
}

/**
 * Text as Postgres can store it: no NUL, no lone surrogate. Either would
 * make the cloud refuse the whole batch, every time it is sent again. Cut
 * to `max` first, so a cut through a surrogate pair is cleaned too.
 */
export function storable(text: string, max?: number): string {
  const cut = max === undefined ? text : text.slice(0, max);
  return cut.toWellFormed().replaceAll("\u0000", "\uFFFD");
}

/**
 * The tables a decision names, as far as the catalog knows them: a table
 * the statement creates under a name the agent chose (`CREATE TABLE
 * "jane@…"`) is the agent's text, so it doesn't go up.
 */
function knownTables(
  tables: string[],
  names: ReadonlySet<string> | undefined,
): string[] {
  return tables
    .filter((t) => {
      const dot = t.indexOf(".");
      return (
        names !== undefined &&
        dot > 0 &&
        names.has(t.slice(0, dot)) &&
        names.has(t.slice(dot + 1))
      );
    })
    .slice(0, AUDIT_TABLES_MAX)
    .filter((t) => t.length <= AUDIT_FIELD_MAX.table);
}

/** One stored event as the cloud may see it. */
export function project(row: AuditRow, ctx: ProjectionContext): AuditRecord {
  const event = AuditEventSchema.parse(JSON.parse(row.body));
  const base = {
    seq: row.seq,
    // The chain's own hash would let the cloud test a guess at the text.
    hash: ctx.checkpoint(row.hash),
    query_id: storable(event.query_id, AUDIT_FIELD_MAX.queryId),
    at: storable(event.at, AUDIT_FIELD_MAX.at),
  };
  switch (event.event) {
    case "ATTEMPTED": {
      // Without a catalog, every name counts as the agent's own.
      const names = namesOf(ctx.catalog(event.database)) ?? new Set<string>();
      const redacted: RedactedStatement = redactStatement(event.sql, names);
      let truncated = false;
      let statement: string | null = null;
      if (redacted.ok) {
        const c = cut(redacted.sql, AUDIT_TEXT_MAX.statement);
        statement = c.text;
        truncated ||= c.cut;
      }
      let full: { sql: string; intent: string } | null = null;
      if (ctx.fullText(event.database)) {
        const sql = cut(storable(event.sql), AUDIT_TEXT_MAX.statement);
        const intent = cut(storable(event.intent), AUDIT_TEXT_MAX.intent);
        full = { sql: sql.text, intent: intent.text };
        truncated ||= sql.cut || intent.cut;
      }
      return {
        ...base,
        event: "ATTEMPTED",
        database: event.database,
        sub: storable(event.sub, AUDIT_FIELD_MAX.principal),
        client_id: storable(event.client_id, AUDIT_FIELD_MAX.principal),
        grant_id: storable(event.grant_id, AUDIT_FIELD_MAX.principal),
        statement,
        withheld: redacted.ok ? null : redacted.withheld,
        // Every statement's, text or not: a write that starts with WITH
        // reads as a write by its kind.
        kinds: redacted.kinds
          .slice(0, AUDIT_KINDS_MAX)
          .map((k) => k.slice(0, AUDIT_FIELD_MAX.kind)),
        full,
        truncated,
      };
    }
    case "DECIDED": {
      const database = ctx.attempted(event.query_id)?.database;
      const reason =
        event.reason !== null && database && ctx.fullText(database)
          ? cut(storable(event.reason), AUDIT_TEXT_MAX.reason).text
          : null;
      return {
        ...base,
        event: "DECIDED",
        verdict: event.verdict,
        rule: event.rule,
        class: event.class,
        // libpg_query's fingerprint covers names: with a placeholder's
        // fingerprint, a guessed name could be confirmed offline.
        fingerprint: null,
        tables: knownTables(
          event.tables,
          database ? namesOf(ctx.catalog(database)) : undefined,
        ),
        taints: event.taints,
        masked: event.masked ?? null,
        policy_version: event.policy_version ?? null,
        reason,
      };
    }
    case "APPROVAL":
      return {
        ...base,
        event: "APPROVAL",
        approval_id: event.approval_id,
        step: event.step,
        status: event.status,
        preview: event.preview,
      };
    case "EXECUTED":
      return {
        ...base,
        event: "EXECUTED",
        row_count: event.row_count,
        duration_ms: event.duration_ms,
        truncated: event.truncated,
      };
    case "FAILED":
      // Postgres' message can quote a row: only its code goes.
      return {
        ...base,
        event: "FAILED",
        sqlstate: event.sqlstate?.slice(0, AUDIT_FIELD_MAX.sqlstate) ?? null,
      };
  }
}

/** What a batch's POST came to. */
export type PushAnswer =
  /** A verified ack. */
  | { ok: true; acked: number }
  /**
   * The cloud refused the batch, doesn't take audit at all (404), or is
   * storing another batch of this gateway's (429).
   */
  | { ok: false; status: number }
  /**
   * A verified ack of this batch naming another event than the one sent
   * at `forked`: the cloud holds another history for this instance. It
   * stored the batch up to `acked`, below `forked`, and nothing after.
   */
  | { ok: false; forked: number; acked: number };

/**
 * The cloud's answer to a batch didn't verify, or names another event than
 * the one sent even for a new instance: nothing is acked, and the batch
 * goes again.
 */
export class AuditAckError extends Error {
  override name = "AuditAckError";
  readonly fields: Record<string, unknown>;
  constructor(message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.fields = fields;
  }
}

export interface AuditPusherOptions {
  audit: LocalAuditLog;
  context: ProjectionContext;
  send(batch: AuditBatch): Promise<PushAnswer>;
  log: Logger;
  /** Delays, in milliseconds. */
  timing?: {
    /** After a wake, so a burst of events goes in one batch. */
    debounceMs: number;
    /** A flush at least this often, to retry. */
    idleMs: number;
    /** Backoff after a failure, doubling up to the max. */
    minRetryMs: number;
    maxRetryMs: number;
    /** After the cloud refuses a batch or doesn't take audit. */
    refusedMs: number;
    /**
     * After a 429, one to three times this, a step longer for each 429 in
     * a row, up to the max.
     */
    slowDownMs?: number;
    slowDownMaxMs?: number;
    /**
     * How long 429s in a row are retried so; past it they are an outage,
     * said once and then backed off from like any failure.
     */
    slowDownLimitMs?: number;
  };
}

const TIMING = {
  debounceMs: 1_000,
  idleMs: 30_000,
  minRetryMs: 1_000,
  maxRetryMs: 5 * 60_000,
  refusedMs: 5 * 60_000,
  slowDownMs: 1_000,
  slowDownMaxMs: 12_000,
  slowDownLimitMs: 2 * 60_000,
};

/** Push the audit file's unacked events, oldest first, until none are left. */
export class AuditPusher {
  private readonly o: AuditPusherOptions;
  private readonly t: typeof TIMING;
  private readonly stopper = new AbortController();
  private wake: (() => void) | null = null;
  private woken = false;
  private loop: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Records per batch: smaller after the cloud refuses one as too large. */
  private batchMax = AUDIT_BATCH_MAX;
  /** 429s in a row, since any other answer. */
  private slowed = 0;
  /** When the first of them came; null since any other answer. */
  private slowedSince: number | null = null;
  /** Whether 429s were said to be an outage, since the last ack. */
  private slowWarned = false;
  /** The instance a fork made, until one of its batches is acked. */
  private forkedTo: string | null = null;

  constructor(o: AuditPusherOptions) {
    this.o = o;
    this.t = { ...TIMING, ...o.timing };
  }

  start(): void {
    if (this.loop) return;
    this.unsubscribe = this.o.audit.onAppend(() => this.kick());
    this.loop = this.run();
  }

  /** New events are on disk: push soon. */
  kick(): void {
    this.woken = true;
    this.wake?.();
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.stopper.abort();
    await this.loop;
  }

  /** Sleep until the delay passes or the pusher stops; a wakeable one also ends on a kick. */
  private sleep(ms: number, wakeable: boolean): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopper.signal;
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      if (wakeable) this.wake = done;
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopper.signal.aborted) {
      if (!this.woken) await this.sleep(this.t.idleMs, true);
      if (this.stopper.signal.aborted) break;
      if (this.woken) {
        // Let a burst of events land, then send them together.
        this.woken = false;
        await this.sleep(this.t.debounceMs, false);
      }
      try {
        const outcome = await this.flush();
        failures = 0;
        if (outcome === "refused") await this.sleep(this.t.refusedMs, false);
      } catch (err) {
        if (this.stopper.signal.aborted) break;
        failures++;
        const delay = Math.min(
          this.t.maxRetryMs,
          this.t.minRetryMs * 2 ** (failures - 1),
        );
        // An answer that didn't verify is no outage: it gets its own message.
        this.o.log(
          err instanceof AuditAckError
            ? {
                level: "error",
                msg: err.message,
                ...err.fields,
                retry_ms: delay,
              }
            : {
                level: "warn",
                msg: "audit push failed",
                error: (err as Error).message,
                retry_ms: delay,
              },
        );
        await this.sleep(delay, false);
      }
    }
  }

  /**
   * Send batches until nothing is owed. "refused" when the cloud refused
   * one: nothing is skipped, so it waits and tries the same events again.
   */
  async flush(): Promise<"done" | "refused"> {
    for (;;) {
      if (this.stopper.signal.aborted) return "done";
      const rows = this.o.audit.unacked(this.batchMax);
      if (rows.length === 0) return "done";
      const records: AuditRecord[] = [];
      let bytes = 0;
      for (const row of rows) {
        // Redaction parses: the event loop gets a turn after every record.
        await new Promise((resolve) => setImmediate(resolve));
        const record = projectSafely(row, this.o.context, this.o.log);
        const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length > 0 && bytes + size > BATCH_TARGET_BYTES) break;
        records.push(record);
        bytes += size;
      }
      const sent = records.at(-1)?.seq ?? 0;
      let answer: PushAnswer;
      try {
        answer = await this.o.send({
          instance: this.o.audit.instance,
          records,
        });
      } catch (err) {
        this.calm();
        throw err;
      }
      // Only 429s in a row count towards the limit: a run broken by any
      // other answer, or a failure, starts again from the next one.
      if (!("status" in answer && answer.status === 429)) this.calm();
      if ("forked" in answer) {
        // What the cloud stored before the conflict is acked as usual, and
        // isn't sent again.
        const acked = Math.min(answer.acked, answer.forked - 1, sent);
        if (acked >= (records[0]?.seq ?? 0)) {
          this.o.audit.ack(acked);
          this.slowWarned = false;
          this.forkedTo = null;
        }
        // Once per new instance until an ack: a cloud that names another
        // event for one it can't have seen before is wrong, not a fork.
        if (this.forkedTo === this.o.audit.instance) {
          throw new AuditAckError(
            "Midplane Cloud holds another event for the new instance too",
            { seq: answer.forked },
          );
        }
        const from = this.o.audit.instance;
        this.forkedTo = this.o.audit.newInstance();
        this.o.log({
          level: "warn",
          msg: "audit file forked from what Midplane Cloud holds; sending it as a new instance",
          seq: answer.forked,
          instance: this.forkedTo,
          from,
        });
        continue;
      }
      if (!answer.ok) {
        if (answer.status === 429) {
          // Another process with this identity is pushing (replicas share
          // one, and the cloud stores one batch per gateway at a time). Not
          // a failure: try again soon and quietly, a little later each time.
          // Minutes of it is no contention, though: a cloud or a proxy that
          // keeps answering 429 would hide an outage.
          this.slowedSince ??= Date.now();
          if (Date.now() - this.slowedSince < this.t.slowDownLimitMs) {
            this.slowed++;
            await this.sleep(this.slowDown(), false);
            continue;
          }
          if (!this.slowWarned) {
            this.slowWarned = true;
            this.o.log({
              level: "warn",
              msg: "audit push waiting: Midplane Cloud keeps answering 429",
              from: records[0]?.seq,
              to: sent,
            });
          }
          throw new Error("Midplane Cloud keeps answering 429");
        }
        // A batch the cloud refuses as too large or malformed is tried
        // again smaller, down to one record, before the loop waits.
        if (
          (answer.status === 400 || answer.status === 413) &&
          records.length > 1
        ) {
          this.batchMax = Math.max(1, Math.floor(records.length / 2));
          continue;
        }
        this.o.log({
          level: answer.status === 404 ? "warn" : "error",
          msg:
            answer.status === 404
              ? "Midplane Cloud doesn't take audit events yet; upgrade it"
              : "Midplane Cloud refused audit events",
          status: answer.status,
          from: records[0]?.seq,
          to: sent,
        });
        return "refused";
      }
      // Never beyond what was sent, whatever the answer says.
      const acked = Math.min(answer.acked, sent);
      if (acked < (records[0]?.seq ?? 0)) {
        throw new Error("the cloud acked none of the batch");
      }
      this.o.audit.ack(acked);
      this.slowWarned = false;
      this.forkedTo = null;
      // Grow back after a refusal, a step at a time.
      this.batchMax = Math.min(AUDIT_BATCH_MAX, this.batchMax * 2);
    }
  }

  /** Not slowed down: the next 429 starts a run of its own. */
  private calm(): void {
    this.slowed = 0;
    this.slowedSince = null;
  }

  /** The wait after a 429, jittered so replicas don't keep colliding. */
  private slowDown(): number {
    const ceiling = Math.min(
      this.t.slowDownMaxMs,
      this.t.slowDownMs * (2 + this.slowed),
    );
    return (ceiling * (1 + 2 * Math.random())) / 3;
  }
}

/**
 * Project a row, and never fail to: a record that won't validate goes as
 * its minimal form (an ATTEMPTED without text), so one event can't hold up
 * every event after it.
 */
function projectSafely(
  row: AuditRow,
  ctx: ProjectionContext,
  log: Logger,
): AuditRecord {
  let projected: unknown;
  try {
    projected = project(row, ctx);
    const parsed = AuditRecordSchema.safeParse(projected);
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  log({
    level: "warn",
    msg: "audit event sent without its details",
    seq: row.seq,
  });
  const event = AuditEventSchema.parse(JSON.parse(row.body));
  const base = {
    seq: row.seq,
    hash: ctx.checkpoint(row.hash),
    query_id: storable(event.query_id, AUDIT_FIELD_MAX.queryId),
    at: storable(event.at, AUDIT_FIELD_MAX.at),
  };
  if (event.event === "ATTEMPTED") {
    return AuditRecordSchema.parse({
      ...base,
      event: "ATTEMPTED",
      database: event.database,
      sub: storable(event.sub, AUDIT_FIELD_MAX.principal) || "?",
      client_id: storable(event.client_id, AUDIT_FIELD_MAX.principal) || "?",
      grant_id: storable(event.grant_id, AUDIT_FIELD_MAX.principal) || "?",
      statement: null,
      withheld: "check",
      kinds: [],
      full: null,
      truncated: false,
    });
  }
  // Other events are built from the schema the file was written with; one
  // that still fails is a bug worth stopping for.
  return AuditRecordSchema.parse(projected);
}
