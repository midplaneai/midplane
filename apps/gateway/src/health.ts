// Each database's health: whether the most recently completed attempt to
// reach it (a catalog read, a statement, a probe) got an answer, and since
// when that has been so. Until its catalog has been read, though, only a
// catalog read can say a database is up: one that answers a ping but can't
// be read isn't served. The status carries health to Midplane Cloud as codes
// only; the Postgres message, which can name roles and hosts, goes no
// further than the local log.

import type { DatabaseHealth } from "@midplane/protocol";
import type { Attempt, AttemptKind } from "./executor.ts";
import type { Logger } from "./log.ts";

/**
 * How long a linked gateway waits before try `n` (from 0) of a database it
 * has never read: 1 s, 2 s, 4 s, … and never more than 30 s.
 */
export function retryDelay(n: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
}

export class HealthBook {
  private readonly entries = new Map<string, DatabaseHealth>();
  /** Databases whose catalog has been read at least once. */
  private readonly read = new Set<string>();
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(o: { log: Logger; now?: () => Date }) {
    this.log = o.log;
    this.now = o.now ?? (() => new Date());
  }

  /**
   * Record a completed attempt: the last to finish wins. The log says when
   * a database stops answering (or fails differently) and when it's back.
   */
  record(id: string, attempt: Attempt, kind: AttemptKind): void {
    if (attempt.ok && kind === "catalog") this.read.add(id);
    if (attempt.ok && !this.read.has(id)) return;
    const before = this.entries.get(id);
    const code = attempt.ok ? null : attempt.code;
    const changed = before?.ok !== attempt.ok;
    this.entries.set(id, {
      ok: attempt.ok,
      code,
      since: changed || !before ? this.now().toISOString() : before.since,
    });
    if (!attempt.ok && (changed || before?.code !== code)) {
      this.log({
        level: "warn",
        msg: "database unreachable",
        database: id,
        code,
        error: attempt.message,
      });
    } else if (attempt.ok && before && !before.ok) {
      this.log({ level: "info", msg: "database reachable", database: id });
    }
  }

  get(id: string): DatabaseHealth | undefined {
    return this.entries.get(id);
  }
}
