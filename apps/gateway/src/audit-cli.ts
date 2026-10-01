// `midplane audit export` and `midplane audit verify`: the full record, in
// storage the customer controls, and a check that nothing in it was removed
// or changed.
//
// An export is JSON lines: a header naming the file's instance and the
// anchor its chain starts from, then one line per event with its sequence,
// the hash before it, its own hash and the event. Each hash covers
// `JSON.stringify(event)`, which is the stored body byte for byte, so an
// export verifies on its own. The cloud's export of what it holds serves as
// checkpoints: every hash it recorded must match. It holds them keyed with
// the file's checkpoint key, which the header carries, so an export checks
// against them offline.

import { once } from "node:events";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { AuditEventSchema } from "@midplane/protocol";
import {
  type AuditAnchor,
  AuditFileReader,
  type AuditRow,
  type ChainCheck,
  ChainVerifier,
  checkpointOf,
} from "./audit.ts";

/** The first line of an export. */
export interface ExportHeader {
  midplane_audit: 1;
  /** The file's instance; null for one only a gateway before 0.21 has opened. */
  instance: string | null;
  /** The event before the first exported one: where verification starts. */
  anchor: AuditAnchor;
  /**
   * The key of the hashes Midplane Cloud holds for the file. Null for a file
   * no gateway made one in; absent from an export made before there was one.
   */
  checkpoint_key?: string | null;
}

async function writeLine(out: Writable, line: string): Promise<void> {
  if (!out.write(`${line}\n`)) await once(out, "drain");
}

/** Write the file's events from `since` on (all by default) as JSON lines. */
export async function exportAudit(o: {
  file: string;
  out: Writable;
  since?: number;
}): Promise<{ events: number; instance: string | null }> {
  const reader = new AuditFileReader(o.file);
  try {
    const since = o.since ?? 0;
    const header: ExportHeader = {
      midplane_audit: 1,
      instance: reader.instance,
      anchor: since > 0 ? reader.before(since) : reader.anchor,
      checkpoint_key: reader.checkpointKey,
    };
    await writeLine(o.out, JSON.stringify(header));
    let events = 0;
    for (const r of reader.rows(since)) {
      await writeLine(
        o.out,
        JSON.stringify({
          seq: r.seq,
          prev_hash: r.prev_hash,
          hash: r.hash,
          event: JSON.parse(r.body),
        }),
      );
      events++;
    }
    return { events, instance: reader.instance };
  } finally {
    reader.close();
  }
}

export interface VerifyResult {
  check: ChainCheck;
  instance: string | null;
  /** The first event checked; null when there were none. */
  first: number | null;
  /** Checkpoints for this instance within the checked range, all matched. */
  checkpoints: number;
  /** Checkpoints from before the first event checked (pruned here). */
  before: number;
  /** Checkpoints after the last event checked (the cloud's export is newer). */
  after: number;
}

/** One audit file's hashes as Midplane Cloud recorded them. */
export interface InstanceCheckpoints {
  /** The gateways the export says pushed this instance: one, honestly. */
  gateways: Set<string>;
  hashes: Map<number, string>;
}

/** Hashes by instance, from the cloud's export (or any JSON lines with them). */
export type Checkpoints = Map<string, InstanceCheckpoints>;

export async function readCheckpoints(path: string): Promise<Checkpoints> {
  const out: Checkpoints = new Map();
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const { instance, seq, hash, gateway } = (row ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof instance !== "string" ||
      typeof seq !== "number" ||
      typeof hash !== "string"
    ) {
      continue;
    }
    const m = out.get(instance) ?? { gateways: new Set(), hashes: new Map() };
    if (typeof gateway === "string") m.gateways.add(gateway);
    m.hashes.set(seq, hash);
    out.set(instance, m);
  }
  return out;
}

/**
 * Check rows against the chain and, when given, the cloud's checkpoints,
 * which are the rows' hashes under `key`. With checkpoints, the record must
 * be one the cloud knows: its instance appears there, under one gateway; its
 * anchor, if the cloud saw that event, has the cloud's hash; and at least
 * one of the cloud's hashes falls within it. A live file (`live`) must also
 * reach as far as the cloud saw.
 */
async function verifyStream(
  rows: AsyncIterable<AuditRow> | Iterable<AuditRow>,
  anchor: AuditAnchor,
  instance: string | null,
  key: string | null,
  checkpoints: Checkpoints | null,
  live: boolean,
): Promise<VerifyResult> {
  const fail = (seq: number, problem: string): VerifyResult => ({
    check: { ok: false, seq, problem },
    instance,
    first: null,
    checkpoints: 0,
    before: 0,
    after: 0,
  });
  let mine = new Map<number, string>();
  /** A hash of the record as the cloud holds it. */
  let keyed = (hash: string) => hash;
  if (checkpoints) {
    if (!instance) {
      return fail(
        0,
        "this record names no instance, so Midplane Cloud's hashes can't be matched to it",
      );
    }
    if (!key) {
      return fail(
        0,
        "this record has no checkpoint key, which Midplane Cloud's hashes of it are made with, so they can't be matched: export the file again with this midplane",
      );
    }
    const k = key;
    keyed = (hash) => checkpointOf(k, hash);
    const entry = checkpoints.get(instance);
    if (!entry) {
      return fail(
        0,
        `Midplane Cloud's export has no events of this file (instance ${instance}): it may be another gateway's, or the export of another project or time`,
      );
    }
    if (entry.gateways.size > 1) {
      return fail(
        0,
        `Midplane Cloud's export lists instance ${instance} under ${entry.gateways.size} gateways; export one gateway's events`,
      );
    }
    mine = entry.hashes;
    const atAnchor = mine.get(anchor.seq);
    if (
      anchor.seq > 0 &&
      atAnchor !== undefined &&
      atAnchor !== keyed(anchor.hash)
    ) {
      return fail(
        anchor.seq,
        `the record starts after event ${anchor.seq}, whose hash differs from what Midplane Cloud recorded`,
      );
    }
  }
  const v = new ChainVerifier(anchor);
  let first: number | null = null;
  let matched = 0;
  let failure: { seq: number; problem: string } | null = null;
  for await (const r of rows) {
    first ??= r.seq;
    if (!v.add(r)) break;
    const expected = mine.get(r.seq);
    if (expected !== undefined) {
      if (expected !== keyed(r.hash)) {
        failure = {
          seq: r.seq,
          problem: `event ${r.seq} differs from what Midplane Cloud recorded`,
        };
        break;
      }
      matched++;
    }
  }
  const check: ChainCheck = failure ? { ok: false, ...failure } : v.result();
  let before = 0;
  let after = 0;
  if (check.ok) {
    const last = check.last.seq;
    for (const seq of mine.keys()) {
      if (first !== null && seq >= first && seq <= last) continue;
      // At or before the anchor, pruned here; or after this record's head,
      // when the cloud's export is newer than this one.
      if (seq <= last) before++;
      else after++;
    }
  }
  if (check.ok && checkpoints && matched === 0) {
    return fail(
      0,
      "none of Midplane Cloud's hashes for this file fall within this record",
    );
  }
  if (check.ok && live && after > 0) {
    return {
      check: {
        ok: false,
        seq: check.last.seq,
        problem: `Midplane Cloud recorded ${after} events past this file's last one (${check.last.seq}): the file was cut short`,
      },
      instance,
      first,
      checkpoints: matched,
      before,
      after,
    };
  }
  return { check, instance, first, checkpoints: matched, before, after };
}

/** Verify a live audit file, read-only. */
export async function verifyAuditFile(
  file: string,
  checkpoints: Checkpoints | null = null,
): Promise<VerifyResult> {
  const reader = new AuditFileReader(file);
  try {
    return await verifyStream(
      reader.rows(),
      reader.anchor,
      reader.instance,
      reader.checkpointKey,
      checkpoints,
      true,
    );
  } finally {
    reader.close();
  }
}

/** Verify an export made by `midplane audit export`. */
export async function verifyAuditExport(
  path: string,
  checkpoints: Checkpoints | null = null,
): Promise<VerifyResult> {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const it = lines[Symbol.asyncIterator]();
  const head = await it.next();
  let header: ExportHeader;
  try {
    header = JSON.parse(head.done ? "" : head.value) as ExportHeader;
    if (header.midplane_audit !== 1 || !header.anchor) throw new Error();
  } catch {
    lines.close();
    return {
      check: { ok: false, seq: 0, problem: "it isn't a Midplane audit export" },
      instance: null,
      first: null,
      checkpoints: 0,
      before: 0,
      after: 0,
    };
  }
  let lineNo = 1;
  async function* rows(): AsyncGenerator<AuditRow> {
    for (let n = await it.next(); !n.done; n = await it.next()) {
      lineNo++;
      if (!n.value.trim()) continue;
      const line = JSON.parse(n.value) as {
        seq: number;
        prev_hash: string;
        hash: string;
        event: unknown;
      };
      // The event must still be one the gateway could have written.
      const event = AuditEventSchema.safeParse(line.event);
      if (!event.success) {
        throw new Error(`line ${lineNo} doesn't hold an audit event`);
      }
      yield {
        seq: line.seq,
        prev_hash: line.prev_hash,
        hash: line.hash,
        body: JSON.stringify(line.event),
      };
    }
  }
  try {
    return await verifyStream(
      rows(),
      header.anchor,
      header.instance,
      header.checkpoint_key ?? null,
      checkpoints,
      false,
    );
  } catch (err) {
    return {
      check: { ok: false, seq: 0, problem: (err as Error).message },
      instance: header.instance,
      first: null,
      checkpoints: 0,
      before: 0,
      after: 0,
    };
  } finally {
    lines.close();
  }
}

/** One line for a person: what was checked, or the first problem. */
export function describeVerify(r: VerifyResult): string {
  if (!r.check.ok) return `audit chain broken: ${r.check.problem}`;
  const range =
    r.first === null
      ? "no events"
      : `${r.check.events} events, ${r.first} to ${r.check.last.seq}`;
  const notes: string[] = [];
  if (r.checkpoints > 0 || r.before > 0 || r.after > 0)
    notes.push(`${r.checkpoints} of Midplane Cloud's hashes matched`);
  if (r.before > 0) notes.push(`${r.before} from before this record's start`);
  if (r.after > 0)
    notes.push(
      `${r.after} newer than this record (export it again to check them)`,
    );
  const cps = notes.length > 0 ? `; ${notes.join(", ")}` : "";
  return `audit chain verified: ${range}, head ${r.check.last.hash}${cps}`;
}
