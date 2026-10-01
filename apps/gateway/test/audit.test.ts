// The audit file, its push and its export, without Postgres: instances,
// what a linked gateway owes the cloud, retention that keeps the chain
// checkable, the projection the cloud may see, the push loop's acks, and
// export and verify, the record the customer keeps.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadParser } from "@midplane/core";
import {
  AUDIT_BATCH_MAX,
  AUDIT_FIELD_MAX,
  AUDIT_GENESIS_HASH,
  AUDIT_TEXT_MAX,
  AUDIT_UPLOAD_MAX_BYTES,
  type AuditBatch,
  type AuditEvent,
  AuditEventSchema,
  AuditRecordSchema,
  type CatalogSnapshot,
} from "@midplane/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuditFileReader, LocalAuditLog } from "../src/audit.ts";
import {
  describeVerify,
  exportAudit,
  verifyAuditExport,
  verifyAuditFile,
} from "../src/audit-cli.ts";
import {
  AuditAckError,
  AuditPusher,
  cut,
  type ProjectionContext,
  type PushAnswer,
  project,
} from "../src/audit-push.ts";
import { auditFileOf } from "../src/config.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

beforeAll(async () => {
  await loadParser();
});

const tmp = () => mkdtempSync(join(tmpdir(), "midplane-audit-"));

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAfter = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

function attempted(
  queryId: string,
  sql: string,
  o: Partial<Extract<AuditEvent, { event: "ATTEMPTED" }>> = {},
): AuditEvent {
  return {
    event: "ATTEMPTED",
    query_id: queryId,
    at: OLD,
    database: "main",
    sub: "user-1",
    client_id: "client-1",
    grant_id: "grant-1",
    sql,
    intent: "find the customer",
    ...o,
  };
}

/** One event of every kind, in a query's order. */
function lifecycle(queryId: string, at = OLD): AuditEvent[] {
  return [
    attempted(queryId, "SELECT email FROM customers WHERE id = 7", { at }),
    {
      event: "DECIDED",
      query_id: queryId,
      at,
      verdict: "hold",
      rule: null,
      reason: null,
      class: "row_changes",
      fingerprint: "abcd1234abcd1234",
      tables: ["public.customers"],
      taints: false,
      masked: true,
      policy_version: 3,
    },
    {
      event: "APPROVAL",
      query_id: queryId,
      at,
      approval_id: "apr_1",
      step: "filed",
      status: "pending",
      preview: { count: 2, exact: true, code: null },
    },
    {
      event: "EXECUTED",
      query_id: queryId,
      at,
      row_count: 2,
      duration_ms: 3.25,
      truncated: false,
    },
    {
      event: "FAILED",
      query_id: queryId,
      at,
      sqlstate: "22P02",
      message: 'invalid input syntax for type integer: "jane@acme.com"',
    },
  ];
}

/**
 * A file as a gateway before 0.21 wrote it, with that gateway's schema and
 * INSERT: no instance id, no acked_at, and every row at acked's default, 0.
 */
function preV021File(path: string, events: AuditEvent[]): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE audit_events (
      seq INTEGER PRIMARY KEY,
      query_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      acked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE taints (grant_id TEXT PRIMARY KEY, since TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('opened_at', '${OLD}');
  `);
  const insert = db.prepare(
    "INSERT INTO audit_events (query_id, event, at, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let prev = AUDIT_GENESIS_HASH;
  for (const e of events) {
    const body = JSON.stringify(AuditEventSchema.parse(e));
    const hash = createHash("sha256").update(prev).update(body).digest("hex");
    insert.run(e.query_id, e.event, e.at, body, prev, hash);
    prev = hash;
  }
  db.close();
}

describe("the audit file", () => {
  it("is an instance with an id made with it, kept across opens", () => {
    const dir = tmp();
    const a = new LocalAuditLog(join(dir, "a.db"));
    const id = a.instance;
    a.close();
    const again = new LocalAuditLog(join(dir, "a.db"));
    expect(again.instance).toBe(id);
    again.close();
    const b = new LocalAuditLog(join(dir, "b.db"));
    expect(b.instance).not.toBe(id);
    expect(b.instance).toMatch(/^[0-9a-f-]{36}$/);
    b.close();
  });

  it("owes a linked gateway's events to the cloud until acked, and a local one's to no one", () => {
    const dir = tmp();
    const local = new LocalAuditLog(join(dir, "local.db"));
    for (const e of lifecycle("q1")) local.append(e);
    expect(local.head()).toMatchObject({ seq: 5, unacked: 0 });
    expect(local.unacked(10)).toEqual([]);
    local.close();

    const linked = new LocalAuditLog(join(dir, "linked.db"), { owed: true });
    for (const e of lifecycle("q1")) linked.append(e);
    expect(linked.head()).toMatchObject({ seq: 5, unacked: 5 });
    expect(linked.unacked(2).map((r) => r.seq)).toEqual([1, 2]);
    linked.ack(3);
    expect(linked.unacked(10).map((r) => r.seq)).toEqual([4, 5]);
    expect(linked.head().unacked).toBe(2);
    const head = linked.head();
    expect(head.hash).toBe(linked.events().at(-1)?.hash);
    linked.close();
  });

  it("tells a listener after each durable append, and a failing listener changes nothing", () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"));
    let calls = 0;
    const stop = log.onAppend(() => {
      calls++;
      throw new Error("listener broke");
    });
    log.append(lifecycle("q")[0] as AuditEvent);
    expect(calls).toBe(1);
    stop();
    log.append(lifecycle("q")[1] as AuditEvent);
    expect(calls).toBe(1);
    expect(log.verifyChain()).toBe(true);
    log.close();
  });

  it("takes events from several processes writing the same file, in one chain", () => {
    // Value: protects=two local sessions (two `midplane local --stdio`) sharing one audit file both keep recording, in one chain; fails_when=append takes its sequence or the hash before it from memory rather than from the file inside its write transaction; why_new=the second process's first event made the first refuse every statement until restarted; seam=none
    const path = join(tmp(), "shared.db");
    const one = new LocalAuditLog(path);
    const two = new LocalAuditLog(path);
    for (let i = 0; i < 3; i++) {
      one.append(attempted(`one-${i}`, "SELECT 1"));
      two.append(attempted(`two-${i}`, "SELECT 1"));
    }
    expect(one.events().map((e) => [e.seq, e.event.query_id])).toEqual([
      [1, "one-0"],
      [2, "two-0"],
      [3, "one-1"],
      [4, "two-1"],
      [5, "one-2"],
      [6, "two-2"],
    ]);
    expect(one.verifyChain()).toBe(true);
    expect(one.head()).toMatchObject({ seq: 6 });
    expect(two.head()).toEqual(one.head());
    one.close();
    two.close();
  });

  it("prunes only a prefix of events owed to no one for the window, and verifies from the anchor", () => {
    // Local mode: an event is owed to no one from when it is recorded.
    const log = new LocalAuditLog(join(tmp(), "a.db"));
    for (const e of lifecycle("q1")) log.append(e); // 1-5, old
    for (const e of lifecycle("q2", NOW.toISOString())) log.append(e); // 6-10, recent
    for (const e of lifecycle("q3")) log.append(e); // 11-15, old again
    // The old prefix goes; the recent run stops it, so 11-15 stay.
    expect(log.prune(30, NOW)).toBe(5);
    expect(log.events().map((e) => e.seq)[0]).toBe(6);
    expect(log.anchor().seq).toBe(5);
    expect(log.verifyChain()).toBe(true);
    // Zero keeps everything.
    expect(log.prune(0, NOW)).toBe(0);
    // Later, all of it is old: everything goes, and the next event still
    // follows the anchor.
    expect(log.prune(30, new Date("2027-01-01T00:00:00Z"))).toBe(10);
    expect(log.events()).toEqual([]);
    expect(log.head()).toMatchObject({ seq: 15, unacked: 0 });
    log.append(lifecycle("q4")[0] as AuditEvent);
    expect(log.events().map((e) => e.seq)).toEqual([16]);
    expect(log.verifyChain()).toBe(true);
    log.close();
  });

  it("keeps an event the window's length after the cloud acks it, however old the event", () => {
    // Value: protects=a backlog older than retention, acked after a long outage, stays the full window; fails_when=prune compares the event's own time, or a later ack moves acked_at; why_new=prune was only tested with events acked before the window; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (const e of lifecycle("q1", daysAfter(NOW, -40).toISOString())) {
      log.append(e);
    }
    // Nothing acked: nothing goes, however old.
    expect(log.prune(30, NOW)).toBe(0);
    log.ack(5, NOW);
    expect(log.prune(30, NOW)).toBe(0);
    // An ack that covers them again keeps the first one's time.
    log.ack(5, daysAfter(NOW, 20));
    expect(log.prune(30, daysAfter(NOW, 29))).toBe(0);
    expect(log.prune(30, daysAfter(NOW, 31))).toBe(5);
    expect(log.anchor().seq).toBe(5);
    expect(log.verifyChain()).toBe(true);
    log.close();
  });

  it("keeps the events of an approval that may still be live, however short the window", () => {
    // Value: protects=a held write's ATTEMPTED and APPROVAL stay while its request may still be approved and run, so a recount and check_approval find its statement; fails_when=prune applies a retention shorter than an approval's longest life (24 hours pending, 2 approved); why_new=retention_days: 1 deleted a live approval's events; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"));
    const HOUR = 60 * 60 * 1000;
    const filed = new Date(NOW.getTime() - 25 * HOUR);
    for (const e of lifecycle("q1", filed.toISOString())) log.append(e);
    // A day's window has passed; the approval may still be claimed.
    expect(log.prune(1, NOW)).toBe(0);
    expect(log.heldStatement("apr_1")).toMatchObject({ query_id: "q1" });
    // Once no approval can live that long, the window applies.
    expect(log.prune(1, new Date(filed.getTime() + 26 * HOUR - 1))).toBe(0);
    expect(log.prune(1, new Date(filed.getTime() + 26 * HOUR + 1))).toBe(5);
    expect(log.heldStatement("apr_1")).toBeNull();
    log.close();
  });

  it("owes nothing a gateway before 0.21 recorded, in either mode, and prunes it the window after", () => {
    // Value: protects=a pre-0.21 file is pruned locally, the full window after the upgrade, and never pushes its history once linked; fails_when=the first instance id doesn't mark existing rows not owed, or releases them as of their own time; why_new=no test opened a file from an older gateway; seam=none
    const path = join(tmp(), "local.db");
    preV021File(path, [
      ...lifecycle("q1"),
      ...lifecycle("q2", NOW.toISOString()),
    ]);
    const opened = new Date();
    const local = new LocalAuditLog(path);
    // It never pushed, so nothing went missing: nothing to warn about.
    expect(local.unsent).toBe(0);
    expect(local.head()).toMatchObject({ seq: 10, unacked: 0 });
    // Released now: the prune at start deletes none of it, however old.
    expect(local.prune(30, opened)).toBe(0);
    expect(local.prune(30, daysAfter(opened, 31))).toBe(10);
    expect(local.anchor().seq).toBe(10);
    expect(local.verifyChain()).toBe(true);
    local.close();

    const linkedPath = join(tmp(), "linked.db");
    preV021File(linkedPath, lifecycle("q1"));
    const linked = new LocalAuditLog(linkedPath, { owed: true });
    expect(linked.head()).toMatchObject({ seq: 5, unacked: 0 });
    linked.append(lifecycle("q2")[0] as AuditEvent);
    expect(linked.unacked(10).map((r) => r.seq)).toEqual([6]);
    expect(linked.verifyChain()).toBe(true);
    linked.close();
    // Opened again, the file has its id: what it owes stays owed.
    const again = new LocalAuditLog(linkedPath, { owed: true });
    expect(again.unacked(10).map((r) => r.seq)).toEqual([6]);
    again.close();
  });

  it("stops owing what a linked gateway left unsent once the file is opened in local mode, says how many, and keeps them the window", () => {
    // Value: protects=local mode prunes a file that ran linked, the operator learns which events never reached the cloud, and has the full window to export them; fails_when=opening in local mode leaves acked = 0 rows, doesn't count them, or counts retention from their own time; why_new=the prune at start deleted old unsent events seconds after the warning said they stay; seam=none
    const path = join(tmp(), "a.db");
    const linked = new LocalAuditLog(path, { owed: true });
    for (const e of lifecycle("q1")) linked.append(e);
    for (const e of lifecycle("q2", NOW.toISOString())) linked.append(e);
    linked.ack(2, new Date(OLD));
    linked.close();
    const opened = new Date();
    const local = new LocalAuditLog(path);
    expect(local.unsent).toBe(8);
    expect(local.head()).toMatchObject({ seq: 10, unacked: 0 });
    // The prune at start deletes only what the cloud acked long ago; the
    // unsent events count from now, however old.
    expect(local.prune(30, opened)).toBe(2);
    expect(local.prune(30, daysAfter(opened, 29))).toBe(0);
    expect(local.prune(30, daysAfter(opened, 31))).toBe(8);
    expect(local.anchor().seq).toBe(10);
    expect(local.verifyChain()).toBe(true);
    local.close();
    // Said once: opened again, nothing is left to report.
    const again = new LocalAuditLog(path);
    expect(again.unsent).toBe(0);
    again.close();
  });

  it("notices an edited or removed event", () => {
    const path = join(tmp(), "a.db");
    const log = new LocalAuditLog(path);
    for (const e of lifecycle("q1")) log.append(e);
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "UPDATE audit_events SET body = replace(body, '7', '8') WHERE seq = 1",
      )
      .run();
    expect(log.verifyChain()).toBe(false);
    raw.prepare("DELETE FROM audit_events WHERE seq = 1").run();
    expect(log.verifyChain()).toBe(false);
    raw.close();
    log.close();
  });
});

describe("export and verify", () => {
  const exportTo = async (file: string, since?: number) => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (d) => chunks.push(String(d)));
    await exportAudit({ file, out, ...(since ? { since } : {}) });
    out.end();
    return chunks.join("");
  };

  it("writes every event with its hashes, and the export verifies on its own", async () => {
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path);
    for (const e of lifecycle("q1")) log.append(e);
    const text = await exportTo(path);
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      midplane_audit: 1,
      instance: log.instance,
      anchor: { seq: 0, hash: "0".repeat(64) },
      checkpoint_key: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(lines.slice(1).map((l) => l.event.event)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "APPROVAL",
      "EXECUTED",
      "FAILED",
    ]);
    // The full record: the statement, the intent, the message.
    expect(text).toContain("SELECT email FROM customers WHERE id = 7");
    expect(text).toContain("jane@acme.com");
    writeFileSync(join(dir, "export.jsonl"), text);
    const r = await verifyAuditExport(join(dir, "export.jsonl"));
    expect(r.check).toMatchObject({ ok: true, events: 5 });
    expect(describeVerify(r)).toMatch(/verified: 5 events, 1 to 5/);
    log.close();
  });

  it("refuses an export with an edited, removed or reordered line", async () => {
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path);
    for (const e of lifecycle("q1")) log.append(e);
    const lines = (await exportTo(path)).trim().split("\n");
    const check = async (edited: string[]) => {
      writeFileSync(join(dir, "x.jsonl"), `${edited.join("\n")}\n`);
      return (await verifyAuditExport(join(dir, "x.jsonl"))).check;
    };
    const changed = [...lines];
    changed[1] = (changed[1] as string).replace("id = 7", "id = 8");
    expect(await check(changed)).toMatchObject({
      ok: false,
      seq: 1,
      problem: expect.stringMatching(/was changed/),
    });
    expect(await check(lines.filter((_, i) => i !== 3))).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/missing/),
    });
    expect(
      await check([lines[0], lines[2], lines[1]] as string[]),
    ).toMatchObject({ ok: false });
    expect(await check(["not an export"])).toMatchObject({
      ok: false,
      problem: "it isn't a Midplane audit export",
    });
    log.close();
  });

  it("exports from a sequence, and after pruning, from the anchor", async () => {
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path);
    for (const e of lifecycle("q1")) log.append(e);
    for (const e of lifecycle("q2", NOW.toISOString())) log.append(e);
    writeFileSync(join(dir, "since.jsonl"), await exportTo(path, 4));
    expect(
      (await verifyAuditExport(join(dir, "since.jsonl"))).check,
    ).toMatchObject({
      ok: true,
      events: 7,
    });
    log.prune(30, NOW);
    expect(log.anchor().seq).toBe(5);
    writeFileSync(join(dir, "pruned.jsonl"), await exportTo(path));
    expect(
      (await verifyAuditExport(join(dir, "pruned.jsonl"))).check,
    ).toMatchObject({
      ok: true,
      events: 5,
    });
    log.close();
  });

  it("exports one snapshot of the file, whatever a prune beside it deletes meanwhile", async () => {
    // Value: protects=an export taken while the hourly prune commits still verifies; fails_when=the reader takes its header (instance, anchor) and its rows from different snapshots; why_new=exports were only taken of a file nothing changed meanwhile; seam=none
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path);
    for (const e of lifecycle("q1")) log.append(e);
    for (const e of lifecycle("q2", NOW.toISOString())) log.append(e);
    // The prune commits as the header is written, before any event is read.
    let pruned = -1;
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _encoding, done) {
        if (pruned < 0) pruned = log.prune(30, NOW);
        chunks.push(String(chunk));
        done();
      },
    });
    await exportAudit({ file: path, out });
    expect(pruned).toBe(5);
    writeFileSync(join(dir, "x.jsonl"), chunks.join(""));
    expect((await verifyAuditExport(join(dir, "x.jsonl"))).check).toMatchObject(
      { ok: true, events: 10 },
    );
    log.close();
  });

  it("names a new instance once the file forked: in its head, when opened again, in the export and to verify", async () => {
    // Value: protects=a file restored from a backup goes on as a new instance everywhere its instance is read, losing and acking nothing; fails_when=newInstance changes only memory, or head/the reader keep the id read at open; why_new=an instance never changed before; seam=none
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path, { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    log.ack(3);
    const old = log.instance;
    const id = log.newInstance();
    expect(id).not.toBe(old);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(log.instance).toBe(id);
    // Value: protects=the file keeps the instances it was, so an operator can find their events in the cloud's export; fails_when=newInstance overwrites the id without keeping the old one; why_new=the replaced id was lost; seam=none
    const previous = () =>
      JSON.parse(
        (
          new DatabaseSync(path, { readOnly: true })
            .prepare("SELECT value FROM meta WHERE key = 'previous_instances'")
            .get() as { value: string }
        ).value,
      );
    expect(previous()).toEqual([old]);
    // The same events are owed, now as the new instance.
    expect(log.head()).toMatchObject({ instance: id, seq: 5, unacked: 2 });
    expect(log.verifyChain()).toBe(true);
    const header = JSON.parse((await exportTo(path)).split("\n")[0] as string);
    expect(header.instance).toBe(id);
    // Checked against the cloud's export, only the new instance's hashes
    // count: events from before the fork stand on the chain alone.
    const hashes = new Map(
      log.events().map((e) => [e.seq, log.checkpoint(e.hash)]),
    );
    const cloud = new Map([
      [
        old,
        {
          gateways: new Set(["gw_1"]),
          hashes: new Map([[1, hashes.get(1) as string]]),
        },
      ],
      [
        id,
        {
          gateways: new Set(["gw_1"]),
          hashes: new Map([
            [4, hashes.get(4) as string],
            [5, hashes.get(5) as string],
          ]),
        },
      ],
    ]);
    expect(await verifyAuditFile(path, cloud)).toMatchObject({
      check: { ok: true },
      instance: id,
      checkpoints: 2,
    });
    log.close();
    const again = new LocalAuditLog(path, { owed: true });
    expect(again.instance).toBe(id);
    expect(again.unacked(10).map((r) => r.seq)).toEqual([4, 5]);
    const third = again.newInstance();
    expect(previous()).toEqual([old, id]);
    expect(again.instance).toBe(third);
    again.close();
  });

  it("checks the cloud's hashes as checkpoints, and only for the right file", async () => {
    const dir = tmp();
    const path = join(dir, "a.db");
    const log = new LocalAuditLog(path, { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    const rows = log.events();
    const cp = (
      pairs: [number, string][],
      o: { instance?: string; gateways?: string[] } = {},
    ) =>
      new Map([
        [
          o.instance ?? log.instance,
          { gateways: new Set(o.gateways ?? ["gw_1"]), hashes: new Map(pairs) },
        ],
      ]);
    // The cloud holds each event's hash keyed with the file's secret.
    const all = rows.map(
      (r) => [r.seq, log.checkpoint(r.hash)] as [number, string],
    );
    // Read beside the writer, which still has the file open.
    expect(await verifyAuditFile(path, cp(all))).toMatchObject({
      check: { ok: true },
      checkpoints: 5,
    });
    expect(
      (await verifyAuditFile(path, cp([[2, "f".repeat(64)]]))).check,
    ).toMatchObject({
      ok: false,
      seq: 2,
      problem: expect.stringMatching(
        /differs from what Midplane Cloud recorded/,
      ),
    });
    // The cloud saw events this live file no longer has: it was cut short.
    expect(
      (await verifyAuditFile(path, cp([...all, [9, "f".repeat(64)]]))).check,
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/cut short/) });
    // Another file's hashes, or one instance under two gateways, prove nothing.
    expect(
      (await verifyAuditFile(path, cp(all, { instance: "someone-else" })))
        .check,
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no events of this file/),
    });
    expect(
      (await verifyAuditFile(path, cp(all, { gateways: ["gw_1", "gw_2"] })))
        .check,
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/2 gateways/),
    });
    expect(
      (await verifyAuditFile(path, cp([[40, "f".repeat(64)]]))).check,
    ).toMatchObject({
      ok: false,
    });

    // An export may be older than the cloud's: a note, not a failure.
    writeFileSync(join(dir, "x.jsonl"), await exportTo(path));
    const newer = await verifyAuditExport(
      join(dir, "x.jsonl"),
      cp([...all, [9, "f".repeat(64)]]),
    );
    expect(newer).toMatchObject({ check: { ok: true }, after: 1 });
    expect(describeVerify(newer)).toMatch(/1 newer than this record/);
    // But an export whose header names no instance can't be matched.
    const lines = (await exportTo(path)).trim().split("\n");
    const header = JSON.parse(lines[0] as string);
    writeFileSync(
      join(dir, "y.jsonl"),
      [JSON.stringify({ ...header, instance: null }), ...lines.slice(1)].join(
        "\n",
      ),
    );
    expect(
      (await verifyAuditExport(join(dir, "y.jsonl"), cp(all))).check,
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/names no instance/),
    });
    // Value: protects=an export carries the key the cloud's hashes are made with, so it verifies against them offline, and one without it says it can't; fails_when=the header drops checkpoint_key, or verify compares the cloud's hashes with the plain chain hash; why_new=the cloud's hashes became keyed; seam=none
    expect(header.checkpoint_key).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await verifyAuditExport(join(dir, "x.jsonl"), cp(all))).check,
    ).toMatchObject({ ok: true });
    const { checkpoint_key: _, ...keyless } = header;
    writeFileSync(
      join(dir, "z.jsonl"),
      [JSON.stringify(keyless), ...lines.slice(1)].join("\n"),
    );
    expect(
      (await verifyAuditExport(join(dir, "z.jsonl"), cp(all))).check,
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no checkpoint key/),
    });
    // Its chain still verifies alone.
    expect((await verifyAuditExport(join(dir, "z.jsonl"))).check).toMatchObject(
      { ok: true, events: 5 },
    );

    // A pruned file's anchor must be the event the cloud saw there.
    log.ack(5, new Date(OLD));
    for (const e of lifecycle("q2", NOW.toISOString())) log.append(e);
    log.prune(30, NOW);
    expect(log.anchor().seq).toBe(5);
    expect(
      (
        await verifyAuditFile(
          path,
          cp([
            [5, "f".repeat(64)],
            [6, log.checkpoint(log.events()[0]?.hash as string)],
          ]),
        )
      ).check,
    ).toMatchObject({
      ok: false,
      seq: 5,
      problem: expect.stringMatching(/starts after event 5/),
    });
    log.close();
  });

  it("runs from the command line, reading only audit.file from the config", () => {
    const dir = tmp();
    const log = new LocalAuditLog(join(dir, "audit.db"));
    for (const e of lifecycle("q1")) log.append(e);
    log.close();
    // A DSN from an unset variable: the audit commands don't need it.
    writeFileSync(
      join(dir, "midplane.yaml"),
      "audit: { file: audit.db }\ndatabases:\n  main: { dsn: { env: UNSET_DSN } }\n",
    );
    expect(auditFileOf(join(dir, "midplane.yaml"))).toBe(join(dir, "audit.db"));
    const config = join(dir, "midplane.yaml");
    const exported = execFileSync(process.execPath, [
      CLI,
      "audit",
      "export",
      "--config",
      config,
    ]).toString();
    expect(exported.trim().split("\n")).toHaveLength(6);
    execFileSync(process.execPath, [
      CLI,
      "audit",
      "export",
      "--config",
      config,
      "--out",
      join(dir, "out.jsonl"),
    ]);
    expect(readFileSync(join(dir, "out.jsonl"), "utf8")).toBe(exported);
    // Value: protects=an export (literals, intents, Postgres messages) is created owner-only and never overwrites a file; fails_when=--out loses flags "wx" or mode 0o600; why_new=only the content was read back; seam=none
    expect(statSync(join(dir, "out.jsonl")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "kept.jsonl"), "someone else's file\n");
    const clobber = spawnSync(process.execPath, [
      CLI,
      "audit",
      "export",
      "--config",
      config,
      "--out",
      join(dir, "kept.jsonl"),
    ]);
    expect(clobber.status).not.toBe(0);
    expect(readFileSync(join(dir, "kept.jsonl"), "utf8")).toBe(
      "someone else's file\n",
    );
    const verified = spawnSync(process.execPath, [
      CLI,
      "audit",
      "verify",
      "--file",
      join(dir, "out.jsonl"),
    ]);
    expect(verified.status).toBe(0);
    expect(String(verified.stdout)).toMatch(/audit chain verified/);
    writeFileSync(join(dir, "bad.jsonl"), exported.replace("id = 7", "id = 9"));
    const bad = spawnSync(process.execPath, [
      CLI,
      "audit",
      "verify",
      "--file",
      join(dir, "bad.jsonl"),
    ]);
    expect(bad.status).toBe(1);
    expect(String(bad.stderr)).toMatch(/audit chain broken: event 1/);
    const live = spawnSync(process.execPath, [
      CLI,
      "audit",
      "verify",
      "--config",
      config,
    ]);
    expect(live.status).toBe(0);
  });

  it("reads a file read-only", () => {
    const path = join(tmp(), "a.db");
    const log = new LocalAuditLog(path);
    log.append(lifecycle("q")[0] as AuditEvent);
    const reader = new AuditFileReader(path);
    expect(reader.instance).toBe(log.instance);
    expect(reader.verify()).toMatchObject({ ok: true, events: 1 });
    reader.close();
    log.close();
  });
});

const CATALOG: CatalogSnapshot = {
  relations: [
    {
      schema: "public",
      name: "customers",
      kind: "table",
      columns: [
        { name: "id", type: "integer", category: "N" },
        { name: "email", type: "text", category: "S" },
      ],
    },
  ],
  routines: [],
};

function context(fullText: string[] = []): ProjectionContext & {
  log: LocalAuditLog;
  path: string;
} {
  const path = join(tmp(), "p.db");
  const log = new LocalAuditLog(path, { owed: true });
  return {
    log,
    path,
    fullText: (d) => fullText.includes(d),
    catalog: (d) => (d === "main" ? CATALOG : null),
    attempted: (q) => log.attempted(q),
    checkpoint: (hash) => log.checkpoint(hash),
  };
}

describe("the projection", () => {
  it("sends the statement redacted and never the message, by default", () => {
    const ctx = context();
    for (const e of lifecycle("q1")) ctx.log.append(e);
    ctx.log.append({
      ...(lifecycle("q2")[1] as Extract<AuditEvent, { event: "DECIDED" }>),
      verdict: "deny",
      rule: "parse_error",
      reason: "near 'jane@acme.com'",
    });
    const records = ctx.log
      .unacked(10)
      .map((r) => AuditRecordSchema.parse(project(r, ctx)));
    expect(records[0]).toMatchObject({
      event: "ATTEMPTED",
      statement: "SELECT email FROM customers WHERE id = $1",
      withheld: null,
      full: null,
      truncated: false,
    });
    expect(records[1]).toMatchObject({
      event: "DECIDED",
      masked: true,
      policy_version: 3,
      reason: null,
    });
    expect(records[4]).toEqual({
      seq: 5,
      hash: expect.any(String),
      query_id: "q1",
      at: OLD,
      event: "FAILED",
      sqlstate: "22P02",
    });
    const sent = JSON.stringify(records);
    expect(sent).not.toContain("jane@acme.com");
    expect(sent).not.toContain("find the customer");
    expect(sent).not.toMatch(/id = 7/);
    ctx.log.close();
  });

  it("sends the statement as written, the intent and the reason while the switch is on", () => {
    const ctx = context(["main"]);
    ctx.log.append(attempted("q1", "SELECT email FROM customers WHERE id = 7"));
    ctx.log.append({
      ...(lifecycle("q1")[1] as Extract<AuditEvent, { event: "DECIDED" }>),
      verdict: "deny",
      rule: "table_access",
      reason: "Midplane denied this query because …",
    });
    const [a, d] = ctx.log.unacked(10).map((r) => project(r, ctx));
    expect(a).toMatchObject({
      statement: "SELECT email FROM customers WHERE id = $1",
      full: {
        sql: "SELECT email FROM customers WHERE id = 7",
        intent: "find the customer",
      },
    });
    expect(d).toMatchObject({ reason: "Midplane denied this query because …" });
    ctx.log.close();
  });

  it("replaces names the catalog doesn't know, and gives some statements no text", () => {
    const ctx = context();
    ctx.log.append(
      attempted("q1", `SELECT id FROM customers WHERE email = "jane@acme.com"`),
    );
    ctx.log.append(attempted("q2", "COPY customers TO '/tmp/leak.csv'"));
    ctx.log.append(attempted("q3", "SELECT 'unterminated"));
    ctx.log.append(attempted("q4", "SELECT 1", { database: "other" }));
    const [named, copy, broken, other] = ctx.log
      .unacked(10)
      .map((r) => project(r, ctx));
    expect(named).toMatchObject({
      statement: "SELECT id FROM customers WHERE email = _1",
    });
    expect(copy).toMatchObject({
      statement: null,
      withheld: "kind",
      kinds: ["CopyStmt"],
    });
    expect(broken).toMatchObject({ statement: null, withheld: "parse" });
    expect(other).toMatchObject({ statement: "SELECT $1" });
    ctx.log.close();
  });

  it("gives the cloud a keyed hash, which a guess at a value can't be tested against", () => {
    // Value: protects=invariant 9: the cloud can't confirm a guessed literal or intent offline by hashing the fields it holds with the hash before; fails_when=a record carries the chain hash rather than its HMAC under the file's key; why_new=a 4-digit literal was recovered from the plain chain hash in 12 ms; seam=none
    const ctx = context();
    const first = attempted(
      "q1",
      "SELECT email FROM customers WHERE id = 4711",
    );
    const second = attempted(
      "q2",
      "SELECT email FROM customers WHERE id = 4712",
    );
    ctx.log.append(first);
    ctx.log.append(second);
    const rows = ctx.log.unacked(10);
    const [a, b] = rows.map((r) => AuditRecordSchema.parse(project(r, ctx)));
    // The right guess, with everything else the event holds, intent too.
    const guess = (prev: string, e: AuditEvent) =>
      createHash("sha256")
        .update(prev)
        .update(JSON.stringify(AuditEventSchema.parse(e)))
        .digest("hex");
    // It rebuilds the file's own chain…
    expect(guess(AUDIT_GENESIS_HASH, first)).toBe(rows[0]?.hash);
    expect(guess(rows[0]?.hash as string, second)).toBe(rows[1]?.hash);
    // …but not what the cloud holds, from what it holds.
    expect(a?.hash).not.toBe(guess(AUDIT_GENESIS_HASH, first));
    expect(b?.hash).not.toBe(guess(a?.hash as string, second));
    expect(a?.hash).toBe(ctx.log.checkpoint(rows[0]?.hash as string));
    // The key never goes.
    const key = new DatabaseSync(ctx.path, { readOnly: true })
      .prepare("SELECT value FROM meta WHERE key = 'checkpoint_key'")
      .get() as { value: string };
    expect(key.value).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([a, b])).not.toContain(key.value);
    ctx.log.close();
  });

  it("names each statement's kind, whether its text goes or not", () => {
    // Value: protects=the Query log can label any statement by its kind, a write that starts with WITH included; fails_when=kinds go only with a statement sent without text; why_new=`WITH x AS (…) INSERT …` was labeled a read; seam=none
    const ctx = context();
    ctx.log.append(
      attempted(
        "q1",
        "WITH x AS (SELECT id FROM customers) INSERT INTO customers (id) SELECT id FROM x",
      ),
    );
    ctx.log.append(attempted("q2", "SELECT 1; SELECT 2"));
    const [write, reads] = ctx.log
      .unacked(10)
      .map((r) => AuditRecordSchema.parse(project(r, ctx)));
    expect(write).toMatchObject({
      statement: expect.stringMatching(/^WITH _1 AS/),
      withheld: null,
      kinds: ["InsertStmt"],
    });
    expect(reads).toMatchObject({
      withheld: null,
      kinds: ["SelectStmt", "SelectStmt"],
    });
    ctx.log.close();
  });

  it("never sends a fingerprint, a table the catalog doesn't have, a NUL or a lone surrogate", () => {
    const ctx = context(["main"]);
    ctx.log.append(
      attempted("q1", `CREATE TABLE "jane@acme.com" (a int)`, {
        intent: "a\u0000b\ud800c",
      }),
    );
    ctx.log.append({
      ...(lifecycle("q1")[1] as Extract<AuditEvent, { event: "DECIDED" }>),
      verdict: "allow",
      tables: ["public.jane@acme.com", "public.customers"],
      fingerprint: "abcd1234abcd1234",
    });
    const [a, d] = ctx.log.unacked(10).map((r) => project(r, ctx));
    expect(a).toMatchObject({
      statement: "CREATE TABLE _1 (_2 int)",
      full: { intent: "a\uFFFDb\uFFFDc" },
    });
    expect(d).toMatchObject({
      fingerprint: null,
      tables: ["public.customers"],
    });
    // Value: protects=a capped field never ends in half a surrogate pair, which the cloud refuses on every resend; fails_when=storable runs before the cut instead of after; why_new=only text was cut at a boundary; seam=none
    ctx.log.append({
      ...(attempted("q2", "SELECT 1") as Extract<
        AuditEvent,
        { event: "ATTEMPTED" }
      >),
      sub: `${"a".repeat(AUDIT_FIELD_MAX.principal - 1)}😀`,
    });
    const [, , s] = ctx.log.unacked(10).map((r) => project(r, ctx));
    if (s?.event !== "ATTEMPTED") throw new Error();
    expect(s.sub.isWellFormed()).toBe(true);
    expect(s.sub).toHaveLength(AUDIT_FIELD_MAX.principal);
    expect(AuditRecordSchema.safeParse(s).success).toBe(true);
    ctx.log.close();
  });

  it("cuts long text at a character boundary and says so", () => {
    expect(cut("ab😀", 3)).toEqual({ text: "ab", cut: true });
    expect(cut("abc", 3)).toEqual({ text: "abc", cut: false });
    const ctx = context(["main"]);
    const long = `SELECT id FROM customers WHERE email IN (${Array.from(
      { length: 4000 },
      (_, i) => `'u${i}@acme.com'`,
    ).join(", ")})`;
    ctx.log.append(attempted("q1", long, { intent: "x".repeat(10_000) }));
    const [r] = ctx.log.unacked(1).map((row) => project(row, ctx));
    const rec = AuditRecordSchema.parse(r);
    expect(rec).toMatchObject({ event: "ATTEMPTED", truncated: true });
    if (rec.event !== "ATTEMPTED") throw new Error();
    expect(rec.full?.sql.length).toBe(AUDIT_TEXT_MAX.statement);
    expect(rec.full?.intent.length).toBe(AUDIT_TEXT_MAX.intent);
    ctx.log.close();
  });
});

describe("the push loop", () => {
  function pusher(
    log: LocalAuditLog,
    answer: (b: AuditBatch) => PushAnswer | Promise<PushAnswer>,
    context: Partial<ProjectionContext> = {},
  ) {
    const batches: AuditBatch[] = [];
    const logged: Record<string, unknown>[] = [];
    const p = new AuditPusher({
      audit: log,
      context: {
        fullText: () => false,
        catalog: () => CATALOG,
        attempted: (q) => log.attempted(q),
        checkpoint: (hash) => log.checkpoint(hash),
        ...context,
      },
      send: async (b) => {
        batches.push(b);
        return answer(b);
      },
      log: (line) => logged.push(line),
      timing: {
        debounceMs: 5,
        idleMs: 50,
        minRetryMs: 5,
        maxRetryMs: 20,
        refusedMs: 60_000,
      },
    });
    return { p, batches, logged };
  }
  const ackAll = (b: AuditBatch): PushAnswer => ({
    ok: true,
    acked: b.records.at(-1)?.seq ?? 0,
  });

  it("sends every owed event in batches of at most 200, in order, and marks them acked", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (let i = 0; i < 90; i++)
      for (const e of lifecycle(`q${i}`)) log.append(e);
    const { p, batches } = pusher(log, ackAll);
    expect(await p.flush()).toBe("done");
    expect(batches.map((b) => b.records.length)).toEqual([200, 200, 50]);
    expect(batches.flatMap((b) => b.records.map((r) => r.seq))).toEqual(
      Array.from({ length: 450 }, (_, i) => i + 1),
    );
    expect(batches.every((b) => b.instance === log.instance)).toBe(true);
    expect(log.head().unacked).toBe(0);
    log.close();
  });

  it("never acks beyond what it sent, and resends what the cloud didn't ack", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    const greedy = pusher(log, () => ({ ok: true, acked: 1_000 }));
    await greedy.p.flush();
    log.append(lifecycle("q2")[0] as AuditEvent);
    expect(log.unacked(10).map((r) => r.seq)).toEqual([6]);

    const lagging = new LocalAuditLog(join(tmp(), "b.db"), { owed: true });
    for (const e of lifecycle("q1")) lagging.append(e);
    let first = true;
    const lag = pusher(lagging, (b) => {
      if (first) {
        first = false;
        return { ok: true, acked: 3 };
      }
      return ackAll(b);
    });
    await lag.p.flush();
    expect(lag.batches.map((b) => b.records.map((r) => r.seq))).toEqual([
      [1, 2, 3, 4, 5],
      [4, 5],
    ]);
    expect(lagging.head().unacked).toBe(0);
    log.close();
    lagging.close();
  });

  it("never lets one statement hold up the queue", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    // Forms the deparser can't print, and one nested past the stack.
    log.append(
      attempted("q1", "SELECT JSON_VALUE(email, '$.x') FROM customers"),
    );
    log.append(
      attempted(
        "q2",
        `SELECT ${Array.from({ length: 3000 }, () => "1").join(" + ")}`,
      ),
    );
    log.append(attempted("q3", "SELECT 1"));
    const { p, batches } = pusher(log, ackAll);
    expect(await p.flush()).toBe("done");
    const records = batches.flatMap((b) => b.records);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[0]).toMatchObject({ statement: null, withheld: "check" });
    expect(records[2]).toMatchObject({ statement: "SELECT $1" });
    log.close();
  });

  it("sends an event it can't project as one without text, and the events after it", async () => {
    // Value: protects=an event that can't project never stalls the push or sends text; fails_when=projectSafely rethrows or its fallback keeps statement/full; why_new=existing test only reaches redactStatement's own withheld; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    log.append(
      attempted("q1", "SELECT email FROM customers WHERE id = 7", {
        database: "broken",
      }),
    );
    for (const e of lifecycle("q2")) log.append(e);
    // Its switch is on, and its catalog can't be read.
    const { p, batches } = pusher(log, ackAll, {
      fullText: (d) => d === "broken",
      catalog: (d) => {
        if (d === "broken") throw new Error("the catalog is unreadable");
        return CATALOG;
      },
    });
    expect(await p.flush()).toBe("done");
    const records = batches.flatMap((b) => b.records);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records[0]).toEqual({
      seq: 1,
      hash: expect.any(String),
      query_id: "q1",
      at: OLD,
      event: "ATTEMPTED",
      database: "broken",
      sub: "user-1",
      client_id: "client-1",
      grant_id: "grant-1",
      statement: null,
      withheld: "check",
      kinds: [],
      full: null,
      truncated: false,
    });
    expect(records[1]).toMatchObject({
      statement: "SELECT email FROM customers WHERE id = $1",
    });
    expect(JSON.stringify(records)).not.toMatch(/id = 7|find the customer/);
    expect(log.head().unacked).toBe(0);
    log.close();
  });

  it("tries a batch the cloud refuses as too large again smaller, by bytes", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (let i = 0; i < 6; i++) log.append(lifecycle(`q${i}`)[0] as AuditEvent);
    const { p, batches } = pusher(log, (b) =>
      b.records.length > 2 ? { ok: false, status: 413 } : ackAll(b),
    );
    expect(await p.flush()).toBe("done");
    expect(batches[0]?.records).toHaveLength(6);
    expect(batches[1]?.records).toHaveLength(3);
    expect(log.head().unacked).toBe(0);
    log.close();
  });

  it("stops a batch at a mebibyte, so a backlog of full text goes in several, in order", async () => {
    // Value: protects=a full-text backlog never goes as one POST over the cloud's body cap; fails_when=flush() drops or raises its BATCH_TARGET_BYTES stop; why_new=batches were only split by count or after a 413; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    // Fewer events than a batch holds, but more JSON than one POST may carry.
    const count = 120;
    for (let i = 0; i < count; i++) {
      log.append(
        attempted(
          `q${i}`,
          `SELECT id FROM customers WHERE email = '${"x".repeat(16_000)}'`,
          { intent: "y".repeat(4_000) },
        ),
      );
    }
    const { p, batches } = pusher(log, ackAll, { fullText: () => true });
    expect(await p.flush()).toBe("done");
    const sizes = batches.map((b) => Buffer.byteLength(JSON.stringify(b)));
    expect(count).toBeLessThan(AUDIT_BATCH_MAX);
    expect(sizes.reduce((a, b) => a + b)).toBeGreaterThan(
      AUDIT_UPLOAD_MAX_BYTES,
    );
    expect(batches.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThan(AUDIT_UPLOAD_MAX_BYTES);
    const records = batches.flatMap((b) => b.records);
    expect(records.map((r) => r.seq)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1),
    );
    expect(
      records.every((r) => r.event === "ATTEMPTED" && r.full !== null),
    ).toBe(true);
    expect(log.head().unacked).toBe(0);
    log.close();
  });

  it("goes on as a new instance when the cloud holds another history, once until an ack", async () => {
    // Value: protects=a restored or copied file keeps pushing instead of resending one batch forever, and a cloud that names another event for a fresh instance too doesn't make it rotate in a loop; fails_when=flush treats a fork as a failure, acks on it, or rotates again before an ack; why_new=a fork stalled the push until the disk filled; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    const old = log.instance;
    let forks = 1;
    // The cloud holds another event at the batch's first sequence: it
    // stored none of it.
    const once = pusher(log, (b) =>
      forks-- > 0 ? { ok: false, forked: 1, acked: 0 } : ackAll(b),
    );
    expect(await once.p.flush()).toBe("done");
    expect(once.batches.map((b) => [b.instance, b.records.length])).toEqual([
      [old, 5],
      [log.instance, 5],
    ]);
    expect(log.instance).not.toBe(old);
    expect(log.head().unacked).toBe(0);
    // Value: protects=the fork warning names the instance the file was, whose events the cloud's export holds; fails_when=the warning names only the new instance; why_new=an operator couldn't tell which instance to export; seam=none
    expect(
      once.logged.filter((l) => String(l.msg).startsWith("audit file forked")),
    ).toEqual([
      expect.objectContaining({ seq: 1, instance: log.instance, from: old }),
    ]);

    log.append(lifecycle("q2")[0] as AuditEvent);
    const forked = log.instance;
    const always = pusher(log, () => ({ ok: false, forked: 6, acked: 5 }));
    await expect(always.p.flush()).rejects.toThrow(AuditAckError);
    expect(always.batches.map((b) => b.instance)).toEqual([
      forked,
      log.instance,
    ]);
    expect(log.head().unacked).toBe(1);
    log.close();
  });

  it("counts 429s only in a row: any other answer starts their clock again", async () => {
    // Value: protects=a lone 429 minutes after a run of them broken by an outage or a refusal is a quiet retry, not an outage warning; fails_when=slowedSince resets only on an ack; why_new=the two-minute limit was tested only with 429s and nothing between; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    let now = NOW.getTime();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logged: Record<string, unknown>[] = [];
    const answers: (PushAnswer | Error)[] = [];
    const p = new AuditPusher({
      audit: log,
      context: {
        fullText: () => false,
        catalog: () => CATALOG,
        attempted: (q) => log.attempted(q),
        checkpoint: (hash) => log.checkpoint(hash),
      },
      send: async (b) => {
        const a = answers.shift() ?? ackAll(b);
        if (a instanceof Error) throw a;
        return a;
      },
      log: (line) => logged.push(line),
      timing: {
        debounceMs: 5,
        idleMs: 50,
        minRetryMs: 5,
        maxRetryMs: 20,
        refusedMs: 60_000,
        slowDownMs: 1,
        slowDownMaxMs: 2,
        slowDownLimitMs: 2 * 60_000,
      },
    });
    try {
      for (const broken of [
        new Error("the cloud is down"),
        { ok: false, status: 404 } as const,
      ]) {
        log.append(attempted("q", "SELECT 1"));
        // A 429, then something else.
        answers.push({ ok: false, status: 429 }, broken);
        await (broken instanceof Error
          ? expect(p.flush()).rejects.toThrow("the cloud is down")
          : expect(p.flush()).resolves.toBe("refused"));
        // Minutes later, one 429 is a turn to wait again, and then an ack.
        now += 5 * 60_000;
        answers.push({ ok: false, status: 429 });
        expect(await p.flush()).toBe("done");
        expect(log.head().unacked).toBe(0);
      }
      expect(logged.map((l) => l.msg)).not.toContain(
        "audit push waiting: Midplane Cloud keeps answering 429",
      );
    } finally {
      clock.mockRestore();
      log.close();
    }
  });

  it("acks a batch up to the cloud's conflict, and sends only the rest as the new instance", async () => {
    // Value: protects=after a fork the events the cloud stored before the conflict are acked and not sent again, so the Query log doesn't get them twice, and the rest go as the new instance; fails_when=the pusher ignores a fork's acked prefix, or acks past the conflict; why_new=the cloud acked a whole batch past a conflict, and a fork resent everything owed; seam=none
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    const old = log.instance;
    let forks = 1;
    // A greedy prefix is held below the conflict.
    const { p, batches } = pusher(log, (b) =>
      forks-- > 0 ? { ok: false, forked: 3, acked: 4 } : ackAll(b),
    );
    expect(await p.flush()).toBe("done");
    expect(
      batches.map((b) => [b.instance, b.records.map((r) => r.seq)]),
    ).toEqual([
      [old, [1, 2, 3, 4, 5]],
      [log.instance, [3, 4, 5]],
    ]);
    expect(log.instance).not.toBe(old);
    expect(log.head().unacked).toBe(0);
    log.close();
  });

  it("acks nothing when the cloud refuses, and stops short when it acks none", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    for (const e of lifecycle("q1")) log.append(e);
    const refused = pusher(log, () => ({ ok: false, status: 400 }));
    expect(await refused.p.flush()).toBe("refused");
    expect(log.head().unacked).toBe(5);
    const none = pusher(log, () => ({ ok: true, acked: 0 }));
    await expect(none.p.flush()).rejects.toThrow(/acked none/);
    expect(log.head().unacked).toBe(5);
    log.close();
  });

  it("pushes soon after an append, retries a failure, and stops at once", async () => {
    const log = new LocalAuditLog(join(tmp(), "a.db"), { owed: true });
    let failures = 1;
    const { p, batches } = pusher(log, (b) => {
      if (failures-- > 0) throw new Error("the cloud is down");
      return ackAll(b);
    });
    p.start();
    log.append(lifecycle("q1")[0] as AuditEvent);
    const until = Date.now() + 2_000;
    while (log.head().unacked > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(log.head().unacked).toBe(0);
    expect(batches.length).toBe(2);
    await p.close();
    // Refused now: it waits a minute, and close() doesn't.
    // Value: protects=close() ends a refused push's wait at once; fails_when=the refused sleep ignores the stop signal; why_new=the old half could time close() before its 404, racing the first pusher; seam=none
    const refusing = pusher(log, () => ({ ok: false, status: 404 }));
    log.append(lifecycle("q2")[0] as AuditEvent);
    refusing.p.start();
    refusing.p.kick();
    const refusedBy = Date.now() + 2_000;
    while (refusing.batches.length === 0 && Date.now() < refusedBy) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(refusing.batches).toHaveLength(1);
    expect(log.head().unacked).toBe(1);
    const started = Date.now();
    await refusing.p.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    log.close();
  });
});
