// doctor-cli — subprocess tests with fully controlled env. No live Postgres:
// connectivity checks point at refused ports (fast, deterministic failure),
// and the canary scenario boots the real HTTP transport with a mock executor.

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { startHttp, type HttpHandle } from "../src/transport/http.ts";
import { buildServer } from "../src/server.ts";
import { makeTestEngine, makeTestHandle, type MemoryAuditWriter } from "./_helpers.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

// Port 1 is never listening; connection-refused is immediate.
const DEAD_DSN = "postgres://midplane:sekrit-password@127.0.0.1:1/appdb";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "midplane-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function runDoctor(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Start from a scrubbed slate so the host machine's real config can't leak
  // in. The config loader treats empty-string and unset differently (zod
  // min(1) rejects ""), so the midplane vars must actually be ABSENT.
  const base = { ...process.env } as Record<string, string | undefined>;
  for (const k of [
    "DATABASE_URL",
    "MIDPLANE_POLICY_FILE",
    "MIDPLANE_TRANSPORT",
    "MIDPLANE_TENANT_ID",
    "INDEXER_TOKEN",
  ]) {
    delete base[k];
  }
  const proc = Bun.spawn(["bun", CLI_PATH, "doctor", ...args], {
    env: {
      ...base,
      NO_COLOR: "1",
      DB_PATH: join(tmp, "audit.db"),
      PORT: "1",
      ...env,
    },
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

describe("midplane doctor", () => {
  test("no DATABASE_URL and no policy file → config fail, exit 1", async () => {
    const r = await runDoctor([], {});
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ config");
    expect(r.stdout).toContain("DATABASE_URL");
  });

  test("unreachable DB fails with a credential-free detail line", async () => {
    const r = await runDoctor([], { DATABASE_URL: DEAD_DSN });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ database");
    // Host/db shown for orientation; the password never.
    expect(r.stdout).toContain("127.0.0.1:1/appdb");
    expect(r.stdout).not.toContain("sekrit-password");
    // Default-policy posture and missing audit DB are explained, not failed.
    expect(r.stdout).toContain("MIDPLANE_POLICY_FILE not set");
    expect(r.stdout).toContain("created at first server boot");
    expect(r.stdout).toContain("INDEXER_TOKEN unset");
  });

  test("policy file with lint warnings reports them without failing the check", async () => {
    const policyPath = join(tmp, "p.yaml");
    // Valid, but no tenant_scope → lint warning territory.
    writeFileSync(policyPath, "table_access:\n  default: read\n  tables: {}\n");
    const r = await runDoctor([], { DATABASE_URL: DEAD_DSN, MIDPLANE_POLICY_FILE: policyPath });
    expect(r.stdout).toMatch(/! policy .*warning/);
  });

  test("policy file with a lint ERROR fails doctor", async () => {
    const policyPath = join(tmp, "p.yaml");
    writeFileSync(policyPath, "table_access:\n  default: read_write\n  tables: {}\n");
    const r = await runDoctor([], { DATABASE_URL: DEAD_DSN, MIDPLANE_POLICY_FILE: policyPath });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/✗ policy/);
  });

  test("unparseable policy file fails with the loader's message", async () => {
    const policyPath = join(tmp, "p.yaml");
    writeFileSync(policyPath, "table_access:\n  default: rainbow\n");
    const r = await runDoctor([], { DATABASE_URL: DEAD_DSN, MIDPLANE_POLICY_FILE: policyPath });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/✗ policy/);
  });

  test("stdio transport explains itself instead of probing /health", async () => {
    const r = await runDoctor([], { DATABASE_URL: DEAD_DSN, MIDPLANE_TRANSPORT: "stdio" });
    expect(r.stdout).toContain("transport=stdio");
    expect(r.stdout).toContain("--stdio");
    expect(r.stdout).not.toContain("/health");
  });

  test("--json emits {ok, checks}", async () => {
    const r = await runDoctor(["--json"], { DATABASE_URL: DEAD_DSN });
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(false);
    const names = body.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("config");
    expect(names).toContain("database");
  });
});

describe("midplane doctor against a live server", () => {
  let httpHandle: HttpHandle;
  let audit: MemoryAuditWriter;

  beforeAll(async () => {
    const harness = makeTestEngine();
    harness.executor.result = { rows: [{ "?column?": 1 }], rowCount: 1 };
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

  test("health ok + canary ALLOW with an audit row", async () => {
    audit.events.length = 0;
    const r = await runDoctor(["--server", `http://127.0.0.1:${httpHandle.port}`], {
      DATABASE_URL: DEAD_DSN,
    });
    expect(r.stdout).toMatch(/✓ server .*\/health → 200/);
    expect(r.stdout).toMatch(/✓ canary .*ALLOW/);
    const attempted = audit.events.find((e) => e.event_type === "ATTEMPTED");
    expect(attempted).toBeDefined();
    expect(attempted!.agent_name).toBe("midplane-cli");
    expect(attempted!.agent_intent).toContain("doctor");
    // DB is still dead, so overall doctor exits 1 — independent checks.
    expect(r.exitCode).toBe(1);
  });

  test("--no-canary skips the MCP query", async () => {
    audit.events.length = 0;
    const r = await runDoctor(
      ["--server", `http://127.0.0.1:${httpHandle.port}`, "--no-canary"],
      { DATABASE_URL: DEAD_DSN },
    );
    expect(r.stdout).not.toContain("canary");
    expect(audit.events).toHaveLength(0);
  });

  test("an explicit --server is honored even when transport=stdio", async () => {
    // Without --server, stdio config skips the HTTP checks entirely; with
    // it, the operator pointed doctor at a real server — check it.
    const r = await runDoctor(["--server", `http://127.0.0.1:${httpHandle.port}`], {
      DATABASE_URL: DEAD_DSN,
      MIDPLANE_TRANSPORT: "stdio",
    });
    expect(r.stdout).toMatch(/✓ server .*\/health → 200/);
    expect(r.stdout).not.toContain("transport=stdio —");
  });
});

describe("midplane doctor against a degraded server", () => {
  // A stub that answers /health but garbles /mcp — distinguishes the
  // "listener up, MCP broken" failure from "nothing listening".
  let stub: Server;
  let stubPort: number;
  let healthStatus = 200;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (req.url === "/health") {
        res.statusCode = healthStatus;
        res.end(JSON.stringify({ ok: healthStatus === 200 }));
        return;
      }
      res.statusCode = 500;
      res.end("not an mcp server");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const addr = stub.address();
    stubPort = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("healthy /health but broken /mcp → canary FAIL", async () => {
    healthStatus = 200;
    const r = await runDoctor(["--server", `http://127.0.0.1:${stubPort}`], {
      DATABASE_URL: DEAD_DSN,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/✓ server/);
    expect(r.stdout).toMatch(/✗ canary .*MCP query failed/);
  });

  test("/health non-200 → server FAIL, canary skipped", async () => {
    healthStatus = 500;
    const r = await runDoctor(["--server", `http://127.0.0.1:${stubPort}`], {
      DATABASE_URL: DEAD_DSN,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/✗ server .*→ 500/);
    expect(r.stdout).not.toContain("canary");
  });

  test("explicit --server that's unreachable is a FAIL, not a warn", async () => {
    const r = await runDoctor(["--server", "http://127.0.0.1:1"], {
      DATABASE_URL: DEAD_DSN,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/✗ server .*nothing responding/);
  });
});
