// Database health: the retry schedule for a database never read, how each
// completed attempt moves a database's health, and which failed statements
// count against it.

import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  ExecutionError,
  RowCountError,
  statementAttempt,
} from "../src/executor.ts";
import { HealthBook, retryDelay } from "../src/health.ts";

function databaseError(code: string): pg.DatabaseError {
  const err = new pg.DatabaseError("from postgres", 0, "error");
  err.code = code;
  return err;
}

function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code });
}

describe("the retry schedule", () => {
  it("doubles from 1 s and stays at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50, 5000].map(retryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("a database's health", () => {
  const book = () => {
    const lines: Record<string, unknown>[] = [];
    let at = Date.parse("2026-10-02T09:00:00.000Z");
    const health = new HealthBook({
      log: (l) => lines.push(l),
      now: () => {
        at += 1_000;
        return new Date(at);
      },
    });
    return { health, lines };
  };
  const down = (code: string | null) => ({
    ok: false as const,
    code,
    message: `failed: ${code}`,
  });

  it("changes `since` only when ok changes, and logs going down and coming back", () => {
    const { health, lines } = book();
    health.record("main", { ok: true }, "catalog");
    expect(health.get("main")).toEqual({
      ok: true,
      code: null,
      since: "2026-10-02T09:00:01.000Z",
    });
    health.record("main", { ok: true }, "probe");
    expect(health.get("main")?.since).toBe("2026-10-02T09:00:01.000Z");
    expect(lines).toEqual([]);

    health.record("main", down("ECONNREFUSED"), "statement");
    health.record("main", down("ECONNREFUSED"), "probe");
    expect(health.get("main")).toEqual({
      ok: false,
      code: "ECONNREFUSED",
      since: "2026-10-02T09:00:02.000Z",
    });
    health.record("main", { ok: true }, "statement");
    expect(health.get("main")).toEqual({
      ok: true,
      code: null,
      since: "2026-10-02T09:00:03.000Z",
    });
    expect(lines).toEqual([
      {
        level: "warn",
        msg: "database unreachable",
        database: "main",
        code: "ECONNREFUSED",
        error: "failed: ECONNREFUSED",
      },
      { level: "info", msg: "database reachable", database: "main" },
    ]);
  });

  it("says when a database still down fails differently, and starts down without a recovery", () => {
    const { health, lines } = book();
    health.record("orders", down("ECONNREFUSED"), "catalog");
    health.record("orders", down("28P01"), "catalog");
    health.record("orders", down("28P01"), "catalog");
    expect(health.get("orders")).toEqual({
      ok: false,
      code: "28P01",
      since: "2026-10-02T09:00:01.000Z",
    });
    expect(lines.map((l) => [l.msg, l.code])).toEqual([
      ["database unreachable", "ECONNREFUSED"],
      ["database unreachable", "28P01"],
    ]);
    expect(health.get("main")).toBeUndefined();
  });

  it("counts no ping as up until the database's catalog has been read", () => {
    // It answers SELECT 1, but its catalog can't be read: it isn't served,
    // and a readiness probe mustn't say otherwise.
    const { health, lines } = book();
    health.record("orders", down("42501"), "catalog");
    health.record("orders", { ok: true }, "probe");
    expect(health.get("orders")).toMatchObject({ ok: false, code: "42501" });
    // A failure still counts: the database went away altogether.
    health.record("orders", down("ECONNREFUSED"), "probe");
    expect(health.get("orders")).toMatchObject({
      ok: false,
      code: "ECONNREFUSED",
    });
    health.record("orders", { ok: true }, "catalog");
    health.record("orders", { ok: true }, "probe");
    expect(health.get("orders")).toEqual({
      ok: true,
      code: null,
      since: "2026-10-02T09:00:02.000Z",
    });
    expect(lines.map((l) => [l.msg, l.code])).toEqual([
      ["database unreachable", "42501"],
      ["database unreachable", "ECONNREFUSED"],
      ["database reachable", undefined],
    ]);
  });
});

describe("a failed statement", () => {
  it("counts against its database only when the database didn't answer", () => {
    for (const code of ["08006", "08001", "57P01", "57P02", "57P03"]) {
      expect(statementAttempt(databaseError(code)), code).toMatchObject({
        ok: false,
        code,
      });
    }
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
      expect(statementAttempt(socketError(code)), code).toMatchObject({
        ok: false,
        code,
      });
    }
    expect(
      statementAttempt(new Error("Connection terminated unexpectedly")),
    ).toMatchObject({ ok: false, code: null });
    // A host that never answers: pg's connect timeouts carry no code.
    for (const message of [
      "Connection terminated due to connection timeout",
      "timeout exceeded when trying to connect",
    ]) {
      expect(statementAttempt(new Error(message)), message).toMatchObject({
        ok: false,
        code: "TIMEOUT",
      });
    }
    // An answer, even an error or a cancellation, says the database is up.
    for (const code of ["57014", "42501", "23505", "40001", "57P04"]) {
      expect(statementAttempt(databaseError(code)), code).toEqual({ ok: true });
    }
    // So do Midplane's own checks, which ran on its answers.
    expect(
      statementAttempt(new ExecutionError(null, "the mask salt", null)),
    ).toEqual({ ok: true });
    expect(
      statementAttempt(new RowCountError(3, { count: 2, exact: true })),
    ).toEqual({ ok: true });
  });
});
