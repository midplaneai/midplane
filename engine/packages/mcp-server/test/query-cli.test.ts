// query-cli — drives `midplane query` end-to-end: real HTTP transport, real
// MCP handshake, real engine policy, mock executor. The CLI runs as a
// subprocess (it's the unit under test); the server runs in-process so the
// MemoryAuditWriter is assertable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttp, type HttpHandle } from "../src/transport/http.ts";
import { buildServer } from "../src/server.ts";
import { normalizeServerUrl } from "../src/query-cli.ts";
import {
  makeTestEngine,
  makeTestHandle,
  type MemoryAuditWriter,
  type MockExecutor,
} from "./_helpers.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

let httpHandle: HttpHandle;
let executor: MockExecutor;
let audit: MemoryAuditWriter;

beforeAll(async () => {
  const harness = makeTestEngine();
  executor = harness.executor;
  audit = harness.audit;
  const handle = makeTestHandle({ engine: harness.engine, audit: harness.audit });
  httpHandle = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
  });
});

afterAll(async () => {
  await httpHandle.close();
});

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

function serverUrl(): string {
  return `http://127.0.0.1:${httpHandle.port}/mcp`;
}

describe("midplane query (HTTP)", () => {
  test("allowed query → JSON result when piped, exit 0", async () => {
    executor.result = { rows: [{ n: 1 }], rowCount: 1 };
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "SELECT 1"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout.trim());
    expect(body.allowed).toBe(true);
    expect(body.rowCount).toBe(1);
    expect(body.rows).toEqual([{ n: 1 }]);
  });

  test("audit rows are stamped agent_name=midplane-cli with the default intent", async () => {
    audit.events.length = 0;
    executor.result = { rows: [], rowCount: 0 };
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "SELECT 2"]);
    expect(r.exitCode).toBe(0);
    const attempted = audit.events.find(
      (e) => e.event_type === "ATTEMPTED" && e.payload.sql_raw === "SELECT 2",
    );
    expect(attempted).toBeDefined();
    expect(attempted!.agent_name).toBe("midplane-cli");
    expect(attempted!.agent_intent).toContain("midplane CLI");
  });

  test("--intent overrides the default on the audit row", async () => {
    audit.events.length = 0;
    executor.result = { rows: [], rowCount: 0 };
    await runCli([
      "query",
      "--server",
      serverUrl(),
      "--sql",
      "SELECT 3",
      "--intent",
      "verify tenant scoping",
    ]);
    const attempted = audit.events.find((e) => e.event_type === "ATTEMPTED");
    expect(attempted!.agent_intent).toBe("verify tenant scoping");
  });

  test("denied write → exit 1, rule + verbatim message in JSON", async () => {
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "DELETE FROM users"]);
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout.trim());
    expect(body.allowed).toBe(false);
    expect(body.policy_rule).toBe("table_access");
    expect(typeof body.reason).toBe("string");
  });

  test("--pretty allowed renders a table and row count", async () => {
    executor.result = { rows: [{ id: 1, name: "ada" }], rowCount: 1 };
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "SELECT 4", "--pretty"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ALLOW");
    expect(r.stdout).toMatch(/id +name/);
    expect(r.stdout).toContain("ada");
    expect(r.stdout).toContain("1 row");
  });

  test("--pretty denied shows the agent-facing message and never-reached note", async () => {
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "DELETE FROM users", "--pretty"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("DENY");
    expect(r.stdout).toContain("rule:    table_access");
    expect(r.stdout).toContain("message: ");
    expect(r.stdout).toContain("never reached the database");
  });

  test("positional SQL works without --sql", async () => {
    executor.result = { rows: [], rowCount: 0 };
    const r = await runCli(["query", "SELECT 5", "--server", serverUrl()]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim()).allowed).toBe(true);
  });

  test("unreachable server → friendly error, exit 1", async () => {
    const r = await runCli(["query", "--server", "http://127.0.0.1:1/mcp", "--sql", "SELECT 1"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/cannot reach .*midplane doctor/);
  });

  test("missing sql → usage, exit 2", async () => {
    const r = await runCli(["query", "--server", serverUrl()]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });

  test("--pretty caps the table at 100 rows and says how many more exist", async () => {
    executor.result = {
      rows: Array.from({ length: 101 }, (_, i) => ({ n: i })),
      rowCount: 101,
    };
    const r = await runCli(["query", "--server", serverUrl(), "--sql", "SELECT 6", "--pretty"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("… 1 more rows (use --json for all)");
    expect(r.stdout).toContain("101 rows");
  });

  test("malformed --server URL → usage error, exit 2 (no stack trace)", async () => {
    const r = await runCli(["query", "--server", "http://[bad", "--sql", "SELECT 1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/invalid --server URL/);
    expect(r.stderr).not.toMatch(/at /); // no stack frames
  });

  test("bare --server falls back to the default port, not http://true", async () => {
    // PORT=1 makes the default target a dead port → the friendly error must
    // name localhost:1, proving "true" was not treated as a hostname.
    const r = await runCli(["query", "--server", "--sql", "SELECT 1"], { PORT: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("localhost:1");
    expect(r.stderr).not.toContain("true");
  });
});

describe("midplane query --stdio", () => {
  // Spawns a real child server over stdio. A DENIED statement proves the
  // full path (config load → parser warmup → MCP handshake → policy) without
  // needing a reachable Postgres — the deny short-circuits before any
  // connection is opened. This is exactly the no-PG verification story the
  // flag exists for.
  test("denied write round-trips without a database", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "midplane-query-stdio-"));
    try {
      const r = await runCli(
        ["query", "--stdio", "--sql", "DELETE FROM users"],
        {
          DATABASE_URL: "postgres://stub:stub@127.0.0.1:5/stub",
          DB_PATH: join(tmp, "audit.db"),
          MIDPLANE_POLICY_FILE: "",
        },
      );
      expect(r.exitCode).toBe(1);
      const body = JSON.parse(r.stdout.trim());
      expect(body.allowed).toBe(false);
      expect(body.policy_rule).toBe("table_access");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("normalizeServerUrl", () => {
  test("default falls back to localhost:$PORT/mcp", () => {
    expect(normalizeServerUrl(undefined)).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
  });

  test("bare host:port gains scheme and /mcp", () => {
    expect(normalizeServerUrl("example.com:9000")).toBe("http://example.com:9000/mcp");
  });

  test("root URL routes to /mcp; explicit path is preserved", () => {
    expect(normalizeServerUrl("http://h:1/")).toBe("http://h:1/mcp");
    expect(normalizeServerUrl("https://h/custom")).toBe("https://h/custom");
  });
});
