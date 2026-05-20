// audit-cli — exercises `midplane audit {tail,since,stats}` end-to-end.
//
// Strategy: build a tmp SQLite audit DB via the real SqliteAuditWriter, then
// invoke the CLI as a subprocess (one-shot subcommands) or call parseDuration
// directly (pure unit). Subprocess is `bun src/cli.ts audit ...` with DB_PATH
// pointing at the tmp file.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteAuditWriter, type AuditEvent } from "@midplane/engine";
import { parseDuration } from "../src/audit-cli.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

let tmp: string;
let dbPath: string;
let writer: SqliteAuditWriter;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "midplane-audit-cli-"));
  dbPath = join(tmp, "audit.db");
  writer = new SqliteAuditWriter(dbPath);
});

afterEach(async () => {
  await writer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ULIDs are lexicographically sortable; we just need monotonically increasing
// strings for ordering, not real ULIDs.
function id(n: number): string {
  return `01TESTID${n.toString().padStart(18, "0")}`;
}

async function writeEvent(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "event_type">,
  n: number,
  ts: number,
  explicitId?: string,
): Promise<void> {
  const base = {
    id: explicitId ?? id(n),
    query_id: `Q${n}`,
    tenant_id: "__self_host__",
    database: "__default__",
    agent_name: "test-agent",
    agent_version: "0.0.1",
    agent_intent: null,
    mcp_token_id: null,
    ts,
    schema_version: 3 as const,
  };
  switch (partial.event_type) {
    case "ATTEMPTED":
      await writer.write({
        ...base,
        event_type: "ATTEMPTED",
        payload: { sql_raw: "SELECT 1", sql_fingerprint: "0123456789abcdef" },
      });
      return;
    case "DECIDED":
      await writer.write({
        ...base,
        event_type: "DECIDED",
        payload: partial.payload as never,
      });
      return;
    case "EXECUTED":
      await writer.write({
        ...base,
        event_type: "EXECUTED",
        payload: { exec_ms: 5, overhead_ms: 2, rows_returned: 1 },
      });
      return;
    case "FAILED":
      await writer.write({
        ...base,
        event_type: "FAILED",
        payload: { exec_ms: 1, overhead_ms: 1, error_class: "42P01", error_message: "no table" },
      });
      return;
  }
}

async function runCli(
  args: string[],
  opts: { db?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, DB_PATH: opts.db ?? dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = opts.timeoutMs ?? 5000;
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

describe("parseDuration", () => {
  test("simple units", () => {
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
  });

  test("composite", () => {
    expect(parseDuration("1d12h")).toBe(86_400_000 + 12 * 3_600_000);
    expect(parseDuration("2h30m15s")).toBe(2 * 3_600_000 + 30 * 60_000 + 15_000);
  });

  test("invalid input returns null", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("1")).toBeNull();
    expect(parseDuration("1x")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0h")).toBeNull();
    expect(parseDuration("1h ")).toBeNull();
    expect(parseDuration(" 1h")).toBeNull();
    expect(parseDuration("1h2")).toBeNull();
  });
});

describe("midplane audit since", () => {
  test("emits only rows newer than the window", async () => {
    const now = Date.now();
    await writeEvent({ event_type: "ATTEMPTED" }, 1, now - 2 * 3_600_000); // 2h ago
    await writeEvent({ event_type: "ATTEMPTED" }, 2, now - 30 * 60_000);    // 30m ago
    await writeEvent({ event_type: "ATTEMPTED" }, 3, now - 60_000);         // 1m ago

    const r = await runCli(["audit", "since", "1h"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(ids).toEqual([id(2), id(3)]);
  });

  test("missing duration arg exits 2", async () => {
    const r = await runCli(["audit", "since"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  test("invalid duration exits 2", async () => {
    const r = await runCli(["audit", "since", "banana"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/invalid duration/);
  });
});

describe("midplane audit tail --no-follow", () => {
  test("backfills last N rows in chronological order", async () => {
    const now = Date.now();
    for (let i = 1; i <= 5; i++) {
      await writeEvent({ event_type: "ATTEMPTED" }, i, now - (5 - i) * 1000);
    }
    const r = await runCli(["audit", "tail", "--backfill", "3", "--no-follow"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([id(3), id(4), id(5)]);
  });

  test("payload is JSON-decoded, not a string", async () => {
    await writeEvent({ event_type: "EXECUTED" }, 1, Date.now());
    const r = await runCli(["audit", "tail", "--no-follow"]);
    expect(r.exitCode).toBe(0);
    const row = JSON.parse(r.stdout.trim().split("\n")[0]!);
    expect(row.payload).toEqual({ exec_ms: 5, overhead_ms: 2, rows_returned: 1 });
  });

  test("empty DB produces no output", async () => {
    const r = await runCli(["audit", "tail", "--no-follow"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("midplane audit tail --follow (live polling)", () => {
  // Regression for the same-millisecond / non-monotonic-ULID skip.
  // ULIDs sort by their 48-bit timestamp prefix, but two ids generated in the
  // same millisecond have random suffixes and are NOT mutually monotonic. An
  // earlier version of tail() advanced its cursor by id (`WHERE id > ?`),
  // which would permanently skip a later insert whose random suffix sorted
  // below the previously emitted id. The fix is to use SQLite's rowid, which
  // is strictly monotonic for new inserts.
  test("emits a row whose id sorts BELOW the previously emitted row", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "audit", "tail", "--backfill", "0"], {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        // Tight poll cycle so the test stays under a second total.
        MIDPLANE_AUDIT_TAIL_POLL_MS: "50",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Give the subprocess time to open the DB and snapshot MAX(rowid).
    await Bun.sleep(250);

    const sameMs = Date.now();
    // First insert: lex-HIGH id. With the buggy id-based cursor this id would
    // become the cursor and the second insert would never satisfy id > cursor.
    await writeEvent({ event_type: "ATTEMPTED" }, 0, sameMs, "Z_HIGH_LEX");
    await Bun.sleep(150);
    await writeEvent({ event_type: "ATTEMPTED" }, 0, sameMs, "A_LOW_LEX");
    await Bun.sleep(200);

    proc.kill();
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const ids = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).id);
    expect(stderr).toBe("");
    expect(ids).toContain("Z_HIGH_LEX");
    expect(ids).toContain("A_LOW_LEX");
  });
});

describe("midplane audit stats", () => {
  beforeEach(async () => {
    const now = Date.now();
    // 2 ALLOW SELECT, 1 DENY table_access, 1 EXECUTED.
    await writeEvent({ event_type: "ATTEMPTED" }, 1, now - 60_000);
    await writeEvent(
      {
        event_type: "DECIDED",
        payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: ["t"] } as never,
      },
      2,
      now - 60_000,
    );
    await writeEvent({ event_type: "EXECUTED" }, 3, now - 60_000);
    await writeEvent({ event_type: "ATTEMPTED" }, 4, now - 30_000);
    await writeEvent(
      {
        event_type: "DECIDED",
        payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: ["t"] } as never,
      },
      5,
      now - 30_000,
    );
    await writeEvent(
      {
        event_type: "DECIDED",
        payload: {
          decision: "DENY",
          policy_rule: "table_access",
          reason: "no",
          statement_type: "UPDATE",
        } as never,
      },
      6,
      now - 30_000,
    );
    // Outside the 24h window — should not be counted in default stats.
    await writeEvent({ event_type: "ATTEMPTED" }, 7, now - 48 * 3_600_000);
  });

  test("--json output reflects window groupings", async () => {
    const r = await runCli(["audit", "stats", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.window).toBe("24h");
    const totals = Object.fromEntries(parsed.totals.map((x: { k: string; n: number }) => [x.k, x.n]));
    expect(totals.ATTEMPTED).toBe(2);
    expect(totals.DECIDED).toBe(3);
    expect(totals.EXECUTED).toBe(1);
    expect(totals.FAILED).toBeUndefined();

    const denies = Object.fromEntries(
      parsed.deny_by_rule.map((x: { k: string; n: number }) => [x.k, x.n]),
    );
    expect(denies.table_access).toBe(1);

    const allows = Object.fromEntries(
      parsed.allow_by_statement.map((x: { k: string; n: number }) => [x.k, x.n]),
    );
    expect(allows.SELECT).toBe(2);
  });

  test("text output is human-readable", async () => {
    const r = await runCli(["audit", "stats"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Audit stats — last 24h");
    expect(r.stdout).toContain("Events by type:");
    expect(r.stdout).toContain("Denies by policy rule:");
    expect(r.stdout).toContain("table_access");
  });

  test("--since narrows the window", async () => {
    const r = await runCli(["audit", "stats", "--since", "45s", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const totals = Object.fromEntries(parsed.totals.map((x: { k: string; n: number }) => [x.k, x.n]));
    // Only the events within the last 45 seconds (events 4, 5, 6) qualify.
    expect(totals.ATTEMPTED).toBe(1);
    expect(totals.DECIDED).toBe(2);
    expect(totals.EXECUTED).toBeUndefined();
  });

  test("invalid --since exits 2", async () => {
    const r = await runCli(["audit", "stats", "--since", "nope"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/invalid duration/);
  });
});

describe("midplane audit dispatch", () => {
  test("unknown subcommand exits 2 with help on stderr", async () => {
    const r = await runCli(["audit", "garbage"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown subcommand/);
    expect(r.stderr).toMatch(/Usage:/);
  });

  test("audit help on stdout, exit 0", async () => {
    const r = await runCli(["audit", "help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/midplane audit/);
    expect(r.stdout).toMatch(/tail/);
    expect(r.stdout).toMatch(/since/);
    expect(r.stdout).toMatch(/stats/);
  });

  test("missing DB surfaces a friendly error", async () => {
    const r = await runCli(["audit", "tail", "--no-follow"], {
      db: join(tmp, "does-not-exist.db"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/cannot open/);
  });
});

describe("midplane audit on a pre-migration audit DB", () => {
  test("0.2-shape DB (agent_identity column, no agent_name) is migrated on first invocation", async () => {
    // Tear down the writer the test harness created so we can replace
    // its file with a 0.2-shape DB that the CLI must migrate.
    await writer.close();
    rmSync(dbPath, { force: true });

    const probe = new Database(dbPath);
    probe.run(`
      CREATE TABLE audit_events (
        id              TEXT    PRIMARY KEY,
        query_id        TEXT    NOT NULL,
        tenant_id       TEXT    NOT NULL,
        database        TEXT    NOT NULL DEFAULT '__default__',
        agent_identity  TEXT,
        ts              INTEGER NOT NULL,
        event_type      TEXT    NOT NULL,
        payload         TEXT    NOT NULL,
        schema_version  INTEGER NOT NULL DEFAULT 1
      );
    `);
    probe.run(
      "INSERT INTO audit_events (id, query_id, tenant_id, database, agent_identity, ts, event_type, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "01LEGACY000000000000000001",
        "Q-LEG",
        "__self_host__",
        "__default__",
        null,
        // Recent ts so `audit since 1h` includes the row.
        Date.now() - 60_000,
        "ATTEMPTED",
        '{"sql_raw":"SELECT 1","sql_fingerprint":"0123456789abcdef"}',
        1,
      ],
    );
    probe.close();

    // Reopen the writer so afterEach has something valid to close.
    writer = new SqliteAuditWriter(dbPath);

    const r = await runCli(["audit", "since", "1h"]);
    expect(r.exitCode).toBe(0);
    // Pre-migration row surfaces with the new column shape (nulls on the
    // split fields) instead of the binary crashing.
    expect(r.stdout).toContain("01LEGACY000000000000000001");
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.agent_name).toBeNull();
    expect(parsed.agent_version).toBeNull();
    expect(parsed.agent_intent).toBeNull();
    // intent_source column was dropped in 0.4.0; the CLI's row JSON no
    // longer includes the key at all.
    expect(parsed).not.toHaveProperty("intent_source");
  });
});

describe("midplane top-level dispatch", () => {
  test("version prints package version", async () => {
    const r = await runCli(["version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^midplane \d+\.\d+\.\d+/);
  });

  test("unknown top-level command exits 2", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown command/);
  });

  test("help prints usage", async () => {
    const r = await runCli(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/midplane/);
    expect(r.stdout).toMatch(/audit/);
  });
});
