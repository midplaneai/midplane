// Runtime-agnostic SQLite handle: `bun:sqlite` under Bun, `node:sqlite` under Node.
//
// The engine's primary runtime is Bun — the `midplane/midplane` image is a
// `bun build --compile` binary. The published `midplane` npm package runs on
// plain Node, where `bun:sqlite` does not exist; and Bun (as of 1.3) does not
// implement `node:sqlite`, so neither builtin covers both runtimes. This module
// picks the right one and normalizes the small API delta between them.
//
// The specifier is COMPUTED, never a literal, so neither bundler statically
// resolves the other runtime's builtin — a literal `import "node:sqlite"` fails
// `bun build --compile`, and a literal `import "bun:sqlite"` fails Node with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. `createRequire` keeps the load SYNCHRONOUS,
// which is what lets SqliteAuditWriter's constructor stay synchronous.
//
// The deltas being normalized:
//
//   | operation            | bun:sqlite            | node:sqlite            |
//   | -------------------- | --------------------- | ---------------------- |
//   | constructor          | Database              | DatabaseSync           |
//   | "don't create"       | { create: false }     | (no such option)       |
//   | no row from get()    | null                  | undefined              |
//
// Everything else the audit path uses — prepare/exec/close, and a statement's
// all/get/run/iterate — is already call-compatible, including multi-statement
// exec() and the { changes, lastInsertRowid } run() result.

import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqliteParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array;

// Row and bound-parameter types are declared on prepare(), mirroring
// bun:sqlite's own `query<Row, Params>()` ergonomics so call sites read the same
// on either runtime.
export interface SqliteStatement<
  T = unknown,
  P extends SqliteParam[] = SqliteParam[],
> {
  all(...params: P): T[];
  get(...params: P): T | undefined;
  run(...params: P): { changes: number | bigint };
  iterate(...params: P): IterableIterator<T>;
}

export interface SqliteDatabase {
  prepare<T = unknown, P extends SqliteParam[] = SqliteParam[]>(
    sql: string,
  ): SqliteStatement<T, P>;
  // Executes one or more statements, returning nothing. Used for DDL and PRAGMAs.
  exec(sql: string): void;
  close(): void;
}

export interface OpenOptions {
  // false → refuse to create a missing file, so a typo'd DB_PATH surfaces as an
  // error instead of an empty database. Defaults to true.
  create?: boolean;
}

/** Which SQLite builtin backs this process. Reported by `midplane doctor`. */
export const SQLITE_RUNTIME: "bun" | "node" =
  typeof process.versions.bun === "string" ? "bun" : "node";

// The underlying builtins are structurally identical for our call surface, so
// one loose shape describes both.
interface RawStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
}
interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
  close(): void;
}
type RawDatabaseCtor = new (path: string, opts?: unknown) => RawDatabase;

let ctor: RawDatabaseCtor | undefined;

function databaseCtor(): RawDatabaseCtor {
  if (ctor) return ctor;
  const require_ = createRequire(import.meta.url);
  // Computed, so the bundler leaves it alone (see the header note).
  const specifier = SQLITE_RUNTIME === "bun" ? "bun:sqlite" : "node:sqlite";
  let mod: Record<string, unknown>;
  try {
    mod = require_(specifier) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      SQLITE_RUNTIME === "node"
        ? `midplane requires a Node build with the node:sqlite builtin (Node 22.16+ or 24+); this is ${process.version}. Original error: ${(err as Error).message}`
        : `could not load bun:sqlite: ${(err as Error).message}`,
    );
  }
  ctor = (SQLITE_RUNTIME === "bun" ? mod.Database : mod.DatabaseSync) as
    | RawDatabaseCtor
    | undefined;
  if (!ctor) {
    throw new Error(`${specifier} did not export the expected constructor`);
  }
  return ctor;
}

class Statement<T, P extends SqliteParam[]> implements SqliteStatement<T, P> {
  constructor(private readonly raw: RawStatement) {}

  all(...params: P): T[] {
    return this.raw.all(...params) as T[];
  }

  // node:sqlite returns undefined for "no row", bun:sqlite returns null.
  // Normalize to undefined so callers need only one absence check.
  get(...params: P): T | undefined {
    return (this.raw.get(...params) ?? undefined) as T | undefined;
  }

  run(...params: P): { changes: number | bigint } {
    return this.raw.run(...params);
  }

  iterate(...params: P): IterableIterator<T> {
    return this.raw.iterate(...params) as IterableIterator<T>;
  }
}

class Database implements SqliteDatabase {
  constructor(private readonly raw: RawDatabase) {}

  prepare<T = unknown, P extends SqliteParam[] = SqliteParam[]>(
    sql: string,
  ): SqliteStatement<T, P> {
    return new Statement<T, P>(this.raw.prepare(sql));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Open a SQLite database on whichever runtime is hosting the process.
 *
 * Always read/write. Parent directories are created when `create` is left on,
 * because the off-container default audit path (`~/.midplane/audit.db`) does
 * not exist on a fresh machine and neither builtin does an implicit mkdir.
 */
export function openSqlite(
  path: string,
  opts: OpenOptions = {},
): SqliteDatabase {
  const Ctor = databaseCtor();
  const inMemory = path === ":memory:" || path.startsWith("file::memory:");

  if (opts.create === false) {
    // node:sqlite has no "open but don't create" mode — its only comparable
    // option is readOnly, which we can't use (see openDb() in audit-cli: the
    // audit DB is in WAL mode, and a readonly connection can't initialize the
    // -shm file with no writer attached). Check first, and raise the same
    // message and code sqlite itself would.
    if (!inMemory && !existsSync(path)) {
      const err = new Error("unable to open database file") as Error & {
        code: string;
      };
      err.code = "SQLITE_CANTOPEN";
      throw err;
    }
  } else if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw =
    SQLITE_RUNTIME === "bun"
      ? new Ctor(
          path,
          // bun:sqlite rejects `{ create: false }` on its own — whenever create
          // is off it wants an explicit readwrite/readonly flag. With
          // `create: true` readwrite is implied.
          opts.create === false
            ? { readwrite: true, create: false }
            : { create: true },
        )
      : new Ctor(path);

  return new Database(raw);
}
