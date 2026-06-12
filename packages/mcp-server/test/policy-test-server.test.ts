// `midplane policy test --server` — drives the dry-run wrapper end-to-end
// against a real HTTP transport whose /admin/dry-run is wired to the real
// executeDryRun over a real engine (mock executor; dry-run never executes
// anyway). The CLI runs as a subprocess.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startHttp, type HttpHandle } from "../src/transport/http.ts";
import { buildServer } from "../src/server.ts";
import {
  executeDryRun,
  validateDryRunRequest,
  DryRunError,
  type DryRunTarget,
} from "../src/dry-run.ts";
import { makeTestEngine, makeTestHandle, baseCtx } from "./_helpers.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const TOKEN = "test-indexer-token";

let httpHandle: HttpHandle;

beforeAll(async () => {
  const harness = makeTestEngine();
  const handle = makeTestHandle({ engine: harness.engine, audit: harness.audit });
  // Default policy: no table_access config (reads allow, writes deny), no
  // tenant scoping, guardrails at their default-ON posture — matches a
  // no-YAML boot.
  const target: DryRunTarget = {
    engine: harness.engine,
    tableAccess: undefined,
    tenantScope: { defaultColumn: null, overrides: {}, exempt: [] },
    guardrails: { blockUnqualifiedDml: true, blockDdl: true },
    ctxBase: baseCtx,
  };
  httpHandle = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
    indexer: { audit: handle.registry.audit, token: TOKEN },
    admin: {
      setPolicy: async () => ({ applied_at: new Date().toISOString() }),
      dryRun: async (body) => {
        const req = validateDryRunRequest(body);
        if (req.database !== "__default__") {
          throw new DryRunError(`Unknown database "${req.database}".`);
        }
        return executeDryRun(target, req);
      },
    },
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
    // INDEXER_TOKEN cleared by default so each test states its auth path.
    env: { ...process.env, NO_COLOR: "1", INDEXER_TOKEN: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

function server(): string {
  return `http://127.0.0.1:${httpHandle.port}`;
}

describe("midplane policy test --server", () => {
  test("ALLOW verdict from the live server, with policy hash", async () => {
    const r = await runCli([
      "policy", "test", "--server", server(), "--token", TOKEN, "--sql", "SELECT 1",
    ]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ALLOW");
    expect(r.stdout).toMatch(/loaded policy [0-9a-f]{16}/);
    expect(r.stdout).toContain("would be sent to the database");
  });

  test("DENY verdict exits 1 with the matched rule", async () => {
    const r = await runCli([
      "policy", "test", "--server", server(), "--token", TOKEN, "--sql", "DELETE FROM users",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("DENY");
    expect(r.stdout).toContain("table_access");
    expect(r.stdout).toContain("never reaches the database");
  });

  test("--json emits a parseable verdict object", async () => {
    const r = await runCli([
      "policy", "test", "--server", server(), "--token", TOKEN, "--sql", "SELECT 1", "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe("ALLOW");
    expect(body.policy_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.server).toBe(server());
  });

  test("INDEXER_TOKEN env works in place of --token", async () => {
    const r = await runCli(
      ["policy", "test", "--server", server(), "--sql", "SELECT 1"],
      { INDEXER_TOKEN: TOKEN },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ALLOW");
  });

  test("no token anywhere → exit 2 with an explanation", async () => {
    const r = await runCli(["policy", "test", "--server", server(), "--sql", "SELECT 1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("INDEXER_TOKEN");
  });

  test("wrong token → unauthorized, exit 1", async () => {
    const r = await runCli([
      "policy", "test", "--server", server(), "--token", "wrong", "--sql", "SELECT 1",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unauthorized/);
  });

  test("unknown --db surfaces the server's 400 error", async () => {
    const r = await runCli([
      "policy", "test", "--server", server(), "--token", TOKEN, "--sql", "SELECT 1", "--db", "nope",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown database/);
  });

  test("file + --server together is a usage error", async () => {
    const r = await runCli([
      "policy", "test", "some.yaml", "--server", server(), "--token", TOKEN, "--sql", "SELECT 1",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/not both/);
  });

  test("unreachable server → friendly error", async () => {
    const r = await runCli([
      "policy", "test", "--server", "http://127.0.0.1:1", "--token", TOKEN, "--sql", "SELECT 1",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/cannot reach/);
  });

  test("invalid --server URL → usage error, exit 2", async () => {
    const r = await runCli([
      "policy", "test", "--server", "http://[bad", "--token", TOKEN, "--sql", "SELECT 1",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/invalid --server URL/);
  });

  test("refuses to send the token over plaintext http to a non-loopback host", async () => {
    // Fails closed BEFORE any network I/O — example.invalid never resolves.
    const r = await runCli([
      "policy", "test", "--server", "http://example.invalid:8080", "--token", TOKEN, "--sql", "SELECT 1",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/refusing to send INDEXER_TOKEN over plaintext http/);
    expect(r.stderr).toContain("--allow-http");
  });
});

describe("midplane policy test --server against degraded servers", () => {
  test("server without admin endpoints (no INDEXER_TOKEN) → precise 404 message", async () => {
    // Boot a transport with NO indexer/admin wiring — the field config the
    // message exists for.
    const harness = makeTestEngine();
    const handle = makeTestHandle({ engine: harness.engine, audit: harness.audit });
    const bare = await startHttp(() => buildServer({ handle }), { port: 0, host: "127.0.0.1" });
    try {
      const r = await runCli([
        "policy", "test", "--server", `http://127.0.0.1:${bare.port}`, "--token", TOKEN, "--sql", "SELECT 1",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/no admin endpoints/);
    } finally {
      await bare.close();
    }
  });

  test("200 with a shape that has no verdicts → precise error, not a TypeError", async () => {
    const harness = makeTestEngine();
    const handle = makeTestHandle({ engine: harness.engine, audit: harness.audit });
    const weird = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      indexer: { audit: handle.registry.audit, token: TOKEN },
      admin: {
        setPolicy: async () => ({ applied_at: new Date().toISOString() }),
        // Version-skew stand-in: a 200 body without a verdicts array.
        dryRun: async () => ({ unexpected: true }),
      },
    });
    try {
      const r = await runCli([
        "policy", "test", "--server", `http://127.0.0.1:${weird.port}`, "--token", TOKEN, "--sql", "SELECT 1",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/unexpected response .*no verdicts/);
    } finally {
      await weird.close();
    }
  });
});
