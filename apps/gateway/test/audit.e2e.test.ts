// The audit push end to end, against Postgres and the stand-in cloud.
// Invariant 9 for audit batches: no row value, DSN, salt or Postgres message
// ever reaches the cloud; a statement's literals and the agent's intent reach
// it only while the bundle's switch names the database, and stop once it
// doesn't, and the hash it gets of each event is keyed, so it can't test a
// guess against it. Invariant 2: pushing never gates a statement. Events
// stop being owed only on an ack the cloud signed for them and the bytes it
// received; a file restored from a backup goes on as a new instance from
// the first event the cloud holds otherwise.

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadParser } from "@midplane/core";
import type { AuditBatch, AuditRecord } from "@midplane/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLinkedConfig } from "../src/config.ts";
import { MCP_PATH } from "../src/http.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
import {
  callTool,
  createDatabase,
  hasPostgres,
  type TestDatabase,
  type ToolResult,
} from "./harness.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const marker = (what: string) => `${what}-${randomBytes(6).toString("hex")}`;
/** A row value; a failing cast quotes it in Postgres' message. */
const ROW_SECRET = marker("ROWVALUE");
/** Literals and intents, per phase: off, on, off again. */
const LITERAL = [marker("LITERAL0"), marker("LITERAL1"), marker("LITERAL2")];
const INTENT = [marker("INTENT0"), marker("INTENT1"), marker("INTENT2")];

const POLICY = {
  table_access: {
    tables: { "public.customers": "read", "public.notes": "read_write" },
  },
  writes: { row_changes: "hold" },
};

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const FORK =
  "audit file forked from what Midplane Cloud holds; sending it as a new instance";
/** The literal written as a table name, a value where a name goes. */
const asName = (literal: string) =>
  `nowhere_${literal.toLowerCase().replace(/-/g, "_")}`;

describe.skipIf(!hasPostgres)(
  "the audit push, linked",
  { timeout: 30_000 },
  () => {
    let db: TestDatabase;
    let cloud: FakeCloud;
    let dir: string;
    let port: number;
    let gw: RunningGateway;
    const env: NodeJS.ProcessEnv = {};

    const config = () => {
      const text = JSON.stringify({
        listen: { host: "127.0.0.1", port },
        audit: { file: "audit.db" },
        mask_salt: { env: "SALT" },
        link: {
          cloud_url: cloud.url,
          identity: { file: "identity.json" },
          enrollment_token: { env: "ENROLL" },
        },
        databases: { main: { dsn: { env: "DSN_MAIN" } } },
      });
      const path = join(dir, "midplane.yaml");
      writeFileSync(path, text);
      return parseLinkedConfig(text, path, env);
    };
    const mcpUrl = () => `http://127.0.0.1:${port}${MCP_PATH}`;
    const run = async (sql: string, intent?: string) =>
      callTool(
        mcpUrl(),
        await cloud.agentToken({ audience: mcpUrl(), grantId: "grant-1" }),
        "query",
        { sql, ...(intent !== undefined ? { intent } : {}) },
      );
    const publish = async (extra: Record<string, unknown> = {}) => {
      const { version } = await cloud.publish({ main: POLICY }, extra);
      await waitFor("the bundle", () => gw.link?.version === version);
    };
    /** Every event recorded so far has reached the cloud. */
    const pushed = () =>
      waitFor("the audit push", () => gw.audit.head().unacked === 0);
    const records = (instance = gw.audit.instance): AuditRecord[] =>
      [...(cloud.audit.get(instance)?.values() ?? [])].sort(
        (a, b) => a.seq - b.seq,
      );
    /** The file's events, each with its hash as the cloud holds it: keyed. */
    const keyed = () =>
      gw.audit.events().map((e) => [e.seq, gw.audit.checkpoint(e.hash)]);
    const auditBodies = () =>
      cloud.bodies
        .filter((b) => b.path.endsWith("/audit"))
        .map((b) => b.body)
        .join("\n");
    /** The log lines `body` writes, parsed; it sees them as they come. */
    const logged = async (
      body: (lines: Record<string, unknown>[]) => Promise<void>,
    ) => {
      const lines: Record<string, unknown>[] = [];
      const spy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          try {
            lines.push(JSON.parse(String(chunk)));
          } catch {
            // Not one of the gateway's lines.
          }
          return true;
        });
      try {
        await body(lines);
      } finally {
        spy.mockRestore();
      }
      return lines;
    };
    /**
     * Run a query, then wait for its events to be acked or stored twice:
     * the cloud answered the first push, and the gateway sent it again.
     */
    const answeredTwice = async () => {
      const from = cloud.auditBatches.length;
      expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
      await waitFor(
        "an ack or a second push",
        () =>
          gw.audit.head().unacked === 0 ||
          cloud.auditBatches.slice(from).filter((b) => b.status === 200)
            .length >= 2,
      );
    };

    /**
     * A proxy between the gateway and the cloud: while `cut` is on, it
     * forwards only the last record of each audit batch; while `page` is,
     * it answers each batch itself, with a page that isn't JSON; while
     * `reset` is, with an answer whose connection drops mid-body. With
     * `forge`, it sends the next batch of two records or more on with its
     * second record's hash changed, once.
     */
    const relay = {
      cut: false,
      cuts: 0,
      page: false,
      pages: 0,
      reset: false,
      resets: 0,
      forge: false,
      forged: 0,
    };
    const relayed: typeof fetch = async (input, init) => {
      if (relay.page && String(input).includes("/audit?nonce=")) {
        relay.pages++;
        return new Response("<html>signed in?</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (relay.reset && String(input).includes("/audit?nonce=")) {
        relay.resets++;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"acked":'));
            c.error(new Error("connection reset"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        relay.forge &&
        String(input).includes("/audit?nonce=") &&
        typeof init?.body === "string"
      ) {
        const batch = JSON.parse(init.body) as AuditBatch;
        const second = batch.records[1];
        if (second) {
          relay.forge = false;
          relay.forged++;
          const fake = createHash("sha256").update("forged").digest("hex");
          const records = batch.records.map((r) =>
            r === second ? { ...r, hash: fake } : r,
          );
          return fetch(input, {
            ...init,
            body: JSON.stringify({ ...batch, records }),
          });
        }
      }
      if (
        relay.cut &&
        String(input).includes("/audit?nonce=") &&
        typeof init?.body === "string"
      ) {
        const batch = JSON.parse(init.body) as AuditBatch;
        if (batch.records.length > 1) {
          relay.cuts++;
          const cut = { ...batch, records: batch.records.slice(-1) };
          return fetch(input, { ...init, body: JSON.stringify(cut) });
        }
      }
      return fetch(input, init);
    };
    /** Start (or restart) the gateway, through the relay. */
    const start = () =>
      startLinked(config(), {
        fetch: relayed,
        retry: { minMs: 50, maxMs: 200, cutMs: 200 },
        auditTiming: {
          debounceMs: 10,
          idleMs: 100,
          minRetryMs: 20,
          maxRetryMs: 100,
          refusedMs: 100,
          slowDownMs: 10,
          slowDownMaxMs: 50,
          slowDownLimitMs: 500,
        },
      });

    /** Queries of every outcome, with this phase's literal and intent. */
    const workload = async (phase: number) => {
      const literal = LITERAL[phase] as string;
      const intent = INTENT[phase] as string;
      expect(
        (
          await run(
            `SELECT id FROM customers WHERE email = '${literal}'`,
            intent,
          )
        ).isError,
      ).toBeFalsy();
      // Answered: its result carries the row value.
      expect(
        textOf(await run("SELECT email FROM customers", intent)),
      ).toContain(ROW_SECRET);
      // Denied, naming the literal in its reason.
      expect(
        (await run(`SELECT x FROM ${asName(literal)}`, intent)).isError,
      ).toBe(true);
      // Failed: Postgres quotes the row value in its message.
      const failed = await run("SELECT email::int FROM customers", intent);
      expect(failed.isError).toBe(true);
      expect(textOf(failed)).toContain(ROW_SECRET);
      // Held for approval.
      expect(
        (await run(`INSERT INTO notes (body) VALUES ('${literal}')`, intent))
          .isError,
      ).toBe(true);
    };

    beforeAll(async () => {
      await loadParser();
      db = await createDatabase(
        `CREATE TABLE customers (id int PRIMARY KEY, email text);
         INSERT INTO customers VALUES (1, '${ROW_SECRET}');
         CREATE TABLE notes (id serial PRIMARY KEY, body text);`,
        (role) =>
          `GRANT SELECT ON customers TO ${role};
           GRANT SELECT, INSERT ON notes TO ${role};
           GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
      );
      cloud = await startFakeCloud();
      dir = mkdtempSync(join(tmpdir(), "midplane-audit-e2e-"));
      port = await freePort();
      env.SALT = randomBytes(32).toString("hex");
      env.DSN_MAIN = db.agentDsn;
      env.ENROLL = cloud.enrollmentToken();
      gw = await start();
      await publish();
    }, 60_000);

    afterAll(async () => {
      await gw?.close();
      await cloud?.close();
      await db?.drop();
    });

    it("pushes every event as a projection: statements redacted, no message, no intent", async () => {
      await workload(0);
      await pushed();
      const recs = records();
      const local = gw.audit.events();
      // Every event, in order, each with its own hash, keyed.
      expect(recs.map((r) => [r.seq, r.hash])).toEqual(keyed());
      const statements = recs.flatMap((r) =>
        r.event === "ATTEMPTED" ? [r.statement] : [],
      );
      expect(statements).toContain("SELECT id FROM customers WHERE email = $1");
      expect(statements).toContain("INSERT INTO notes (body) VALUES ($1)");
      expect(
        recs
          .filter((r) => r.event === "ATTEMPTED")
          .every((r) => r.full === null),
      ).toBe(true);
      expect(
        recs
          .filter((r) => r.event === "DECIDED")
          .every((r) => r.reason === null),
      ).toBe(true);
      expect(recs.find((r) => r.event === "FAILED")).toEqual(
        expect.objectContaining({ sqlstate: "22P02" }),
      );
      expect(recs.some((r) => r.event === "APPROVAL")).toBe(true);
      // The local record keeps it all; the cloud's doesn't.
      expect(JSON.stringify(local)).toContain(LITERAL[0]);
      expect(JSON.stringify(local)).toContain(ROW_SECRET);
    });

    it("sends statements as written, with the intent and the reason, while the switch is on", async () => {
      await publish({ audit: { full_text: ["main"] } });
      await workload(1);
      await pushed();
      const recs = records();
      const attempted = recs.filter(
        (r): r is Extract<AuditRecord, { event: "ATTEMPTED" }> =>
          r.event === "ATTEMPTED" && r.full?.intent === INTENT[1],
      );
      expect(attempted.length).toBe(5);
      expect(attempted[0]?.full?.sql).toBe(
        `SELECT id FROM customers WHERE email = '${LITERAL[1]}'`,
      );
      // Redacted text still goes with it.
      expect(attempted[0]?.statement).toBe(
        "SELECT id FROM customers WHERE email = $1",
      );
      expect(
        recs.some(
          (r) =>
            r.event === "DECIDED" && r.reason?.includes("nowhere") === true,
        ),
      ).toBe(true);
    });

    it("stops once the switch is off again", async () => {
      await publish();
      // Value: protects=every statement after the switch goes off is pushed, and none as written; fails_when=the push keeps full text after the bundle drops the switch; why_new=the old filter took every ATTEMPTED (seq > 0), not this phase's; seam=none
      const before = gw.audit.head().seq;
      await workload(2);
      await pushed();
      const fresh = records().filter(
        (r): r is Extract<AuditRecord, { event: "ATTEMPTED" }> =>
          r.event === "ATTEMPTED" && r.seq > before,
      );
      expect(fresh.length).toBe(5);
      expect(fresh.every((r) => r.full === null)).toBe(true);
      expect(auditBodies()).not.toContain(LITERAL[2]);
      expect(auditBodies()).not.toContain(INTENT[2]);
    });

    it("invariant 9: no row value, DSN, salt or Postgres message; literals and intents only while switched on", () => {
      const all = cloud.bodies.map((b) => b.body).join("\n");
      expect(auditBodies().length).toBeGreaterThan(0);
      // Value: protects=the key the cloud's hashes are made with never reaches it, or it could test guesses again; fails_when=the checkpoint key goes in a record or a status; why_new=the cloud's hashes became keyed; seam=none
      const key = (
        new DatabaseSync(join(dir, "audit.db"), { readOnly: true })
          .prepare("SELECT value FROM meta WHERE key = 'checkpoint_key'")
          .get() as { value: string }
      ).value;
      for (const secret of [ROW_SECRET, env.SALT as string, db.agentDsn, key]) {
        expect(all).not.toContain(secret);
      }
      expect(all).not.toContain("invalid input syntax");
      // Phase 0 and 2 (off) never reached the audit push; phase 1 (on) did.
      // Held writes file their statement with the approval, switch or not.
      const audit = auditBodies();
      for (const phase of [0, 2]) {
        const literal = LITERAL[phase] as string;
        expect(audit).not.toContain(literal);
        expect(audit).not.toContain(asName(literal));
        expect(audit).not.toContain(INTENT[phase]);
      }
      expect(audit).toContain(LITERAL[1]);
      expect(audit).toContain(asName(LITERAL[1] as string));
      expect(audit).toContain(INTENT[1]);
    });

    it("names the file's head in every sync's status", async () => {
      expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
      await pushed();
      const head = gw.audit.head();
      const reported = () =>
        cloud.statuses.findLast(
          (s) =>
            s.audit?.instance === head.instance && s.audit.seq === head.seq,
        );
      await waitFor("a status with the head", () => reported() !== undefined);
      // Value: protects=the head's hash is the one the cloud holds for that event, keyed, never the chain's own; fails_when=auditHead sends head() as it is; why_new=the cloud's hashes became keyed; seam=none
      const status = reported();
      expect(status?.audit?.hash).toBe(gw.audit.checkpoint(head.hash));
      expect(status?.audit?.hash).toBe(
        cloud.audit.get(head.instance)?.get(head.seq)?.hash,
      );
    });

    it("invariant 2: a cloud that refuses audit gates nothing, and the backlog drains once it takes it", async () => {
      cloud.refuseAudit(500);
      const before = gw.audit.head().seq;
      const r = await run("SELECT id FROM customers");
      expect(r.isError).toBeFalsy();
      await waitFor("a refused push", () =>
        cloud.auditBatches.some((b) => b.status === 500),
      );
      expect(gw.audit.head().unacked).toBeGreaterThan(0);
      cloud.refuseAudit(null);
      await pushed();
      expect(records().at(-1)?.seq).toBeGreaterThan(before);
    });

    it("records a claim that didn't verify, and pushes it", async () => {
      const held = await run("INSERT INTO notes (body) VALUES ('later')");
      const id = (held.structuredContent as { approval?: { id: string } })
        ?.approval?.id as string;
      expect(id).toBeTruthy();
      await cloud.approve(id);
      cloud.forgeClaims("forge");
      const rerun = await run("INSERT INTO notes (body) VALUES ('later')");
      cloud.forgeClaims(null);
      expect(textOf(rerun)).toMatch(/couldn't confirm the approval/);
      await pushed();
      expect(
        records().some(
          (r) =>
            r.event === "APPROVAL" &&
            r.approval_id === id &&
            r.step === "claim_failed",
        ),
      ).toBe(true);
    });

    it("keeps owing events while the cloud's ack doesn't verify, and says so", async () => {
      // Value: protects=a proxy that answers the push without forwarding it can't make the gateway forget events, and its page in place of an answer reads as one that didn't verify; fails_when=pushAudit takes the answer's acked without verifying its proof for this nonce, or a 200 that isn't JSON throws as an outage; why_new=the ack was the one answer the gateway acts on that wasn't signed; seam=none
      // Value: protects=a signed ack naming another hash than the one sent, with no conflict, or a conflict at the very hash sent, acks nothing and isn't taken for a fork; fails_when=pushAudit takes a hash mismatch for a fork, or a conflict without checking it differs; why_new=a mismatch at acked used to mean a fork; seam=none
      for (const mode of [
        "forge",
        "replay",
        "none",
        "hash",
        "conflict",
      ] as const) {
        const lines = await logged(async () => {
          cloud.forgeAuditAck(mode);
          await answeredTwice();
          expect(gw.audit.head().unacked, mode).toBeGreaterThan(0);
        });
        expect(
          lines.filter(
            (l) => l.msg === "Midplane Cloud's audit answer didn't verify",
          ).length,
          mode,
        ).toBeGreaterThan(0);
        expect(lines.find((l) => /didn't verify/.test(String(l.msg)))).toEqual(
          expect.objectContaining({ level: "error" }),
        );
      }
      cloud.forgeAuditAck(null);
      const page = await logged(async () => {
        relay.page = true;
        const from = relay.pages;
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        await waitFor("two pages", () => relay.pages - from >= 2);
        expect(gw.audit.head().unacked).toBeGreaterThan(0);
        relay.page = false;
      });
      expect(page).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "Midplane Cloud's audit answer didn't verify",
        }),
      );
      await pushed();
      expect(records().map((r) => [r.seq, r.hash])).toEqual(keyed());
    });

    it("takes an answer cut off mid-body for an outage, not one that didn't verify", async () => {
      // Value: protects=a reset or the timeout while the ack's body is read is retried and logged as an outage, not as a cloud whose answer didn't verify; fails_when=pushAudit maps every failure reading the body to undefined; why_new=only a body that wasn't JSON was tested; seam=none
      const lines = await logged(async () => {
        relay.reset = true;
        const from = relay.resets;
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        await waitFor("two cut answers", () => relay.resets - from >= 2);
        expect(gw.audit.head().unacked).toBeGreaterThan(0);
        relay.reset = false;
        await pushed();
      });
      expect(lines).toContainEqual(
        expect.objectContaining({ level: "warn", msg: "audit push failed" }),
      );
      expect(lines.filter((l) => /didn't verify/.test(String(l.msg)))).toEqual(
        [],
      );
    });

    it("keeps owing a batch a proxy forwarded only part of", async () => {
      // Value: protects=a proxy that forwards only a batch's last record gets a genuinely signed ack, and still can't make the gateway forget the records it dropped; fails_when=the ack isn't bound to the bytes posted (verifyAuditAck skips body_sha256, or pushAudit hashes other bytes than it sends); why_new=the signed ack covered only the hash at the acked sequence; seam=none
      const lines = await logged(async () => {
        relay.cut = true;
        const from = relay.cuts;
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        await waitFor(
          "a batch cut twice, or an ack",
          () => relay.cuts - from >= 2 || gw.audit.head().unacked === 0,
        );
        expect(gw.audit.head().unacked).toBeGreaterThan(1);
        relay.cut = false;
        await pushed();
      });
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "Midplane Cloud's audit answer didn't verify",
        }),
      );
      expect(records().map((r) => [r.seq, r.hash])).toEqual(keyed());
    });

    it("acks up to where the cloud acks inside a batch, and sends the rest again", async () => {
      // Value: protects=an ack short of a batch's end marks exactly the events up to it acked, and the rest stay owed until acked; fails_when=flush acks the whole batch on any verified ack, or pushAudit refuses an ack inside the batch; why_new=auditAckOffset had no caller; seam=none
      cloud.auditAckOffset(1);
      const from = cloud.auditBatches.length;
      expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
      const last = gw.audit.head().seq;
      await waitFor("the last event, sent again alone", () =>
        cloud.auditBatches
          .slice(from)
          .some((b) => b.status === 200 && b.seqs.join() === `${last}`),
      );
      // All but the last are acked; the last waits for an ack of its own.
      expect(gw.audit.unacked(10).map((r) => r.seq)).toEqual([last]);
      cloud.auditAckOffset(0);
      await pushed();
      expect(records().at(-1)?.seq).toBe(last);
    });

    it("goes on as a new instance when the cloud holds another event, and only once until an ack", async () => {
      // Value: protects=a conflict the cloud signs never acks the event it names; the file goes on as a new instance once, and a cloud that names a conflict for that one too doesn't make it rotate in a loop; fails_when=pushAudit acks past a conflict, the pusher stalls on it, or rotates on every one; why_new=a mismatch resent one batch forever; seam=none
      const before = gw.audit.instance;
      const lines = await logged(async () => {
        cloud.conflictAudit(true);
        await answeredTwice();
        expect(gw.audit.head().unacked).toBeGreaterThan(0);
        cloud.conflictAudit(false);
        await pushed();
      });
      expect(gw.audit.instance).not.toBe(before);
      expect(lines.filter((l) => l.msg === FORK)).toEqual([
        expect.objectContaining({
          level: "warn",
          instance: gw.audit.instance,
          from: before,
          seq: expect.any(Number),
        }),
      ]);
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "Midplane Cloud holds another event for the new instance too",
          seq: expect.any(Number),
        }),
      );
    });

    it("pushes the genuine events as a new instance when a forged copy reached the cloud first", async () => {
      // Value: protects=a proxy that stores a forged copy of a batch ahead of it can't make the gateway forget the genuine events the cloud then refuses: they go as a new instance, the prefix the cloud took isn't sent again, and nothing is lost; fails_when=the cloud acks a batch past its first conflict, or the gateway acks it, or a fork resends the acked prefix; why_new=a conflict was flagged but acked, and the genuine event never reached the cloud; seam=none
      await pushed();
      // Held back, so the query's events go in one batch.
      cloud.refuseAudit(500);
      const from = gw.audit.head().seq;
      expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
      const events = gw.audit.events().filter((e) => e.seq > from);
      expect(events.length).toBeGreaterThanOrEqual(2);
      const old = gw.audit.instance;
      const lines = await logged(async () => {
        relay.forge = true;
        cloud.refuseAudit(null);
        await pushed();
      });
      expect(relay.forged).toBe(1);
      const [first, forged, ...rest] = events.map((e) => [
        e.seq,
        gw.audit.checkpoint(e.hash),
      ]);
      // The cloud kept the forged event under the old instance…
      const held = records(old).filter((r) => r.seq > from);
      expect(held.map((r) => [r.seq, r.hash])[1]).not.toEqual(forged);
      expect(held.map((r) => [r.seq, r.hash])[0]).toEqual(first);
      // …and has the genuine ones from there under the new one, once.
      expect(gw.audit.instance).not.toBe(old);
      expect(records().map((r) => [r.seq, r.hash])).toEqual([forged, ...rest]);
      expect(gw.audit.head().unacked).toBe(0);
      expect(lines.filter((l) => l.msg === FORK)).toEqual([
        expect.objectContaining({
          seq: forged?.[0],
          from: old,
          instance: gw.audit.instance,
        }),
      ]);
    });

    it("waits its turn quietly while another replica's batch is stored", async () => {
      // Value: protects=replicas sharing one identity push without alarming as failures; fails_when=a 429 throws in the link call or counts as a failure that logs "audit push failed"; why_new=the cloud's 429 to a concurrent batch was untested on the gateway's side; seam=none
      const lines = await logged(async () => {
        cloud.slowDownAudit(3);
        const from = cloud.auditBatches.length;
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        await pushed();
        const answers = cloud.auditBatches.slice(from).map((b) => b.status);
        expect(answers.slice(0, 3)).toEqual([429, 429, 429]);
        expect(answers.at(-1)).toBe(200);
      });
      expect(
        lines.filter((l) => l.level === "warn" || l.level === "error"),
      ).toEqual([]);
    });

    it("says once that the cloud keeps answering 429, then backs off as from any failure", async () => {
      // Value: protects=a cloud or proxy that answers 429 for minutes shows as an audit outage; fails_when=429s are retried quietly however long they last, or the warning comes with each one; why_new=a 429 was retried every few seconds forever, with no log; seam=none
      const lines = await logged(async (lines) => {
        cloud.slowDownAudit(1_000_000);
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        await waitFor(
          "failures past the limit",
          () => lines.filter((l) => l.msg === "audit push failed").length >= 3,
        );
        cloud.slowDownAudit(0);
        await pushed();
      });
      expect(
        lines.filter(
          (l) =>
            l.msg === "audit push waiting: Midplane Cloud keeps answering 429",
        ),
      ).toEqual([
        expect.objectContaining({
          level: "warn",
          from: expect.any(Number),
          to: expect.any(Number),
        }),
      ]);
    });

    it("goes on as a new instance after the file is restored from a backup, losing nothing", async () => {
      // Value: protects=a file restored from a backup, whose sequences the cloud already holds with other events, keeps pushing as a new instance instead of stalling with everything owed until the disk fills; fails_when=the gateway doesn't rotate the instance on a verified ack naming another event, or the status keeps the old instance; why_new=a restore, which operations.md recommends backups for, stalled the push for good; seam=none
      // Value: protects=a restored file's batch that runs past the cloud's newest event forks too, and every event after the restored head reaches the cloud; fails_when=the cloud acks a batch past its first conflict, or the gateway takes that ack; why_new=such a batch was acked whole, and the events at sequences the cloud held were flagged and lost; seam=none
      await pushed();
      const file = join(dir, "audit.db");
      const backup = join(dir, "backup.db");
      const backedUp = gw.audit.head();
      await gw.close();
      for (const ext of ["", "-wal"]) {
        if (existsSync(file + ext)) copyFileSync(file + ext, backup + ext);
      }
      gw = await start();
      for (let i = 0; i < 3; i++) {
        expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
      }
      await pushed();
      const old = gw.audit.instance;
      const held = gw.audit.head().seq;
      await gw.close();
      for (const ext of ["", "-wal", "-shm"])
        rmSync(file + ext, { force: true });
      for (const ext of ["", "-wal"]) {
        if (existsSync(backup + ext)) copyFileSync(backup + ext, file + ext);
      }
      const lines = await logged(async () => {
        // Held back, so what comes next goes in one batch.
        cloud.refuseAudit(500);
        gw = await start();
        expect(gw.audit.head()).toMatchObject({
          seq: backedUp.seq,
          instance: old,
        });
        // More events than the cloud got since the backup: the batch starts
        // at sequences it holds, with other events, and runs past them.
        for (let i = 0; i < 4; i++) {
          expect((await run("SELECT id FROM customers")).isError).toBeFalsy();
        }
        expect(gw.audit.head().seq).toBeGreaterThan(held);
        cloud.refuseAudit(null);
        await pushed();
      });
      expect(lines.filter((l) => l.msg === FORK)).toEqual([
        expect.objectContaining({
          level: "warn",
          instance: gw.audit.instance,
          from: old,
          seq: backedUp.seq + 1,
        }),
      ]);
      expect(gw.audit.instance).not.toBe(old);
      expect(gw.audit.head()).toMatchObject({
        instance: gw.audit.instance,
        unacked: 0,
      });
      // The old instance keeps what it had, and took nothing of the batch.
      expect(records(old).at(-1)?.seq).toBe(held);
      // The new instance is a stream of its own, from the restored head on.
      expect(records().map((r) => [r.seq, r.hash])).toEqual(
        keyed().filter(([seq]) => (seq as number) > backedUp.seq),
      );
      await waitFor("a status naming the new instance", () =>
        cloud.statuses.some((s) => s.audit?.instance === gw.audit.instance),
      );
    });
  },
);
