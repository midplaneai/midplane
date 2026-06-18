// YAML `dialect:` parsing + DatabaseSpec.dialect defaults.
//
// Pins the contracts the engine-factory relies on:
//   1. `dialect:` omitted ⇒ DatabaseSpec.dialect === "postgres".
//   2. `dialect: postgres` parses cleanly (the only public dialect).
//   3. Every other dialect name — including `mysql` (implemented on a branch but
//      held off the public build) and `sqlite` (not implemented) — is rejected
//      at YAML load (zod enum lock). Important: silent acceptance would mean
//      Postgres parsing on a differently-marked DB, a silent-bypass vector.
//   4. Synthetic legacy entries (no policy file, empty YAML, legacy single-
//      DB shape) all carry `dialect: "postgres"` so engine-factory's
//      `getDialect(spec.dialect)` lookup never sees undefined.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DB_NAME,
  parsePolicyYaml,
  resolveDatabasesFromConfig,
} from "../src/config.ts";

describe("config: dialect on databases[] entries", () => {
  test("omitted dialect defaults to 'postgres'", () => {
    const yaml = `databases:
  - name: prod
    url: postgres://x
`;
    const loaded = parsePolicyYaml(yaml, "test");
    expect(loaded.databases[0]!.dialect).toBe("postgres");
  });

  test("explicit `dialect: postgres` accepted", () => {
    const yaml = `databases:
  - name: prod
    url: postgres://x
    dialect: postgres
`;
    const loaded = parsePolicyYaml(yaml, "test");
    expect(loaded.databases[0]!.dialect).toBe("postgres");
  });

  test("`dialect: mysql` is rejected — held off the public build", () => {
    const yaml = `databases:
  - name: prod
    url: mysql://u:p@host:3306/app
    dialect: mysql
`;
    // MySQL is implemented + tested on a branch but deliberately not in the
    // public dialect enum. A user who writes `dialect: mysql` must fail loudly
    // at boot, never silently get Postgres parsing against a MySQL DSN.
    expect(() => parsePolicyYaml(yaml, "test")).toThrow(/dialect/);
  });

  test("unknown dialect name is rejected by zod", () => {
    const yaml = `databases:
  - name: prod
    url: postgres://x
    dialect: sqlite
`;
    // The zod enum is the boundary that stops a doc from compiling with an
    // unsupported value (sqlite is not implemented). Silent acceptance would
    // mean PG parsing on a differently-marked DB — a silent-bypass vector.
    expect(() => parsePolicyYaml(yaml, "test")).toThrow(/dialect/);
  });

  test("multi-DB doc — each entry's dialect is independent", () => {
    // The dialect is per-entry, not a top-level field. Pin that the
    // defaulting applies per-entry so adding a new dialect to one entry
    // can't accidentally retag a sibling.
    const yaml = `databases:
  - name: prod
    url: postgres://a
  - name: analytics
    url: postgres://b
    dialect: postgres
`;
    const loaded = parsePolicyYaml(yaml, "test");
    expect(loaded.databases.map((d) => d.dialect)).toEqual([
      "postgres",
      "postgres",
    ]);
  });
});

describe("config: dialect on synthetic legacy entries", () => {
  // The three synthetic-legacy code paths construct a `__default__`
  // DatabaseSpec from a non-databases[] source. engine-factory then calls
  // `getDialect(spec.dialect)` on it — so dialect MUST be set, not
  // undefined, on every synthetic path. These tests pin each call site.

  test("legacy single-DB YAML carries dialect: 'postgres'", () => {
    const yaml = `table_access:
  default: read
  tables:
    users: read
`;
    const loaded = parsePolicyYaml(yaml, "test");
    expect(loaded.databases).toHaveLength(1);
    expect(loaded.databases[0]!.name).toBe(DEFAULT_DB_NAME);
    expect(loaded.databases[0]!.dialect).toBe("postgres");
  });

  test("empty YAML (null doc) carries dialect: 'postgres'", () => {
    const loaded = parsePolicyYaml("", "test");
    expect(loaded.databases).toHaveLength(1);
    expect(loaded.databases[0]!.dialect).toBe("postgres");
  });

  test("legacy + resolveDatabasesFromConfig fills url but preserves dialect", () => {
    // The boot path takes the synthetic entry's url="" and fills it from
    // env DATABASE_URL via resolveDatabasesFromConfig. Pin that the
    // dialect field survives this last-mile step intact.
    const yaml = `table_access: { default: read, tables: {} }`;
    const loaded = parsePolicyYaml(yaml, "test");
    const resolved = resolveDatabasesFromConfig(loaded, {
      databaseUrl: "postgres://from-env",
      port: 8080,
      dbPath: "/data/audit.db",
      tenantId: "t",
      transport: "http",
    });
    expect(resolved[0]!.dialect).toBe("postgres");
    expect(resolved[0]!.url).toBe("postgres://from-env");
  });
});
