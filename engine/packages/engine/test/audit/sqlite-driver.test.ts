// openSqlite tests — the runtime-agnostic SQLite handle.
//
// This suite runs under bun:test, so it exercises the bun:sqlite branch. The
// node:sqlite branch is covered end-to-end by the node-compat CI job, which
// runs the built bundle on a Node matrix. What's pinned here is the CONTRACT
// both branches have to honor, so a future change to the shim can't quietly
// diverge on one runtime: absence is undefined (not null), create:false raises
// SQLITE_CANTOPEN rather than creating, and the default creates parent dirs.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, SQLITE_RUNTIME } from "../../src/audit/sqlite-driver.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "midplane-sqlite-driver-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openSqlite", () => {
  test("reports the runtime hosting the process", () => {
    // bun:test only ever runs under Bun; the assertion exists so the constant
    // can't be quietly inverted.
    expect(SQLITE_RUNTIME).toBe("bun");
  });

  test("round-trips through prepare/exec/all/get/run/iterate", () => {
    const db = openSqlite(join(dir, "a.db"));
    db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER)");

    const ins = db.prepare<never, [string, number]>(
      "INSERT INTO t (k, n) VALUES (?, ?)",
    );
    expect(Number(ins.run("a", 1).changes)).toBe(1);
    ins.run("b", 2);

    const all = db.prepare<{ k: string; n: number }, []>(
      "SELECT k, n FROM t ORDER BY k",
    );
    expect(all.all()).toEqual([
      { k: "a", n: 1 },
      { k: "b", n: 2 },
    ]);
    expect([...all.iterate()].map((r) => r.k)).toEqual(["a", "b"]);

    const one = db.prepare<{ n: number }, [string]>(
      "SELECT n FROM t WHERE k = ?",
    );
    expect(one.get("b")?.n).toBe(2);
    db.close();
  });

  // The delta that would otherwise leak: bun:sqlite answers null, node:sqlite
  // answers undefined. Callers use `?.` / `??`, which only stay correct if the
  // shim normalizes — and `toBeUndefined` fails on null, so this catches a
  // regression on either runtime.
  test("get() returns undefined (not null) when there is no row", () => {
    const db = openSqlite(join(dir, "b.db"));
    db.exec("CREATE TABLE t (k TEXT)");
    expect(db.prepare("SELECT k FROM t WHERE k = ?").get("nope")).toBeUndefined();
    db.close();
  });

  test("exec() runs multiple statements in one call", () => {
    const db = openSqlite(join(dir, "c.db"));
    db.exec("CREATE TABLE a (x); CREATE TABLE b (y);");
    const names = db
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["a", "b"]);
    db.close();
  });

  test("creates missing parent directories by default", () => {
    // The off-container default is ~/.midplane/audit.db, whose directory does
    // not exist on a fresh machine — and neither builtin does an implicit
    // mkdir, so `npx midplane` would fail at boot without this.
    const nested = join(dir, "deep", "deeper", "audit.db");
    const db = openSqlite(nested);
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(existsSync(nested)).toBe(true);
  });

  test("create:false refuses to create, with a sqlite-shaped error", () => {
    const missing = join(dir, "nope.db");
    expect(() => openSqlite(missing, { create: false })).toThrow(
      /unable to open database file/,
    );
    // Must not have created it as a side effect — the whole point is that a
    // typo'd DB_PATH surfaces instead of silently reading an empty log.
    expect(existsSync(missing)).toBe(false);
  });

  test("create:false opens an existing database read/write", () => {
    const path = join(dir, "exists.db");
    const seed = openSqlite(path);
    seed.exec("CREATE TABLE t (x)");
    seed.close();

    const db = openSqlite(path, { create: false });
    // Read/write, not readonly: the audit DB is in WAL mode and a readonly
    // handle can't initialize the -shm file with no writer attached.
    db.exec("INSERT INTO t (x) VALUES (1)");
    expect(db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM t").get()?.c).toBe(1);
    db.close();
  });

  test("in-memory databases skip both the mkdir and the existence check", () => {
    const db = openSqlite(":memory:", { create: false });
    db.exec("CREATE TABLE t (x)");
    db.close();
  });
});
