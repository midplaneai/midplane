import { access } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProcessSpawner,
  allocateFreePort,
  type ChildHandle,
  type SpawnFn,
} from "../src/spawner-process.ts";
import type { SpawnOptions } from "../src/spawner.ts";

// A fake child process. Records the signals it's sent and lets the test drive
// the exit/error/stderr events. No real process is forked.
class FakeChild implements ChildHandle {
  killed = false;
  pid = 4242;
  readonly killSignals: NodeJS.Signals[] = [];

  private exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  private errorCb: ((err: Error) => void) | undefined;
  private stdoutCb: ((chunk: Buffer) => void) | undefined;
  private stderrCb: ((chunk: Buffer) => void) | undefined;

  readonly stdout = {
    on: (_e: "data", cb: (chunk: Buffer) => void) => {
      this.stdoutCb = cb;
    },
  };
  readonly stderr = {
    on: (_e: "data", cb: (chunk: Buffer) => void) => {
      this.stderrCb = cb;
    },
  };

  /** When set, kill(matching signal) makes the process exit on the next tick. */
  exitOnSignal: NodeJS.Signals | "any" | null = null;
  exitCodeOnKill = 0;

  on(event: "error", cb: (err: Error) => void): void;
  on(
    event: "exit",
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: "error" | "exit", cb: (...args: never[]) => void): void {
    if (event === "exit") this.exitCb = cb as never;
    else this.errorCb = cb as never;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    if (
      this.exitOnSignal === "any" ||
      (this.exitOnSignal !== null && this.exitOnSignal === signal)
    ) {
      setTimeout(() => this.exitCb?.(this.exitCodeOnKill, signal), 0);
    }
    return true;
  }

  /** Simulate a boot crash: emit stderr then a non-zero exit. */
  crash(code: number, stderrText: string): void {
    setTimeout(() => {
      this.stderrCb?.(Buffer.from(stderrText, "utf8"));
      this.exitCb?.(code, null);
    }, 0);
  }

  emitSpawnError(err: NodeJS.ErrnoException): void {
    setTimeout(() => this.errorCb?.(err), 0);
  }
}

function spawnOpts(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
    region: "eu",
    databases: [
      {
        name: "main",
        projectDatabaseId: "01HXYZMAIN0000000000000000",
        dsn: "postgres://user:pw@localhost:5432/app",
        tableAccess: { default: "read", tables: {} },
        tenantScope: { column: null, overrides: {}, exempt: [] },
        guardrails: { block_unqualified_dml: true, block_ddl: true },
      },
    ],
    ...overrides,
  };
}

const okFetch = vi.fn(
  async () => new Response("ok", { status: 200 }),
) as unknown as typeof fetch;

describe("allocateFreePort", () => {
  it("hands out distinct, usable free ports (no port-collision)", async () => {
    const a = await allocateFreePort();
    const b = await allocateFreePort();
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Two sequential allocations must not collide.
    expect(a).not.toBe(b);
  });
});

describe("ProcessSpawner", () => {
  // Ambient env for the curated-env test below: a control-plane secret +
  // control-plane DATABASE_URL (must NOT leak), an allowlisted engine knob
  // (must forward), and an ambient MIDPLANE_TRANSPORT (spawn-managed must win).
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "super-secret-do-not-leak";
    process.env.DATABASE_URL = "postgres://control:plane@localhost/cp";
    process.env.MIDPLANE_TELEMETRY = "0";
    process.env.MIDPLANE_TRANSPORT = "stdio";
  });
  afterEach(() => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.MIDPLANE_TELEMETRY;
    delete process.env.MIDPLANE_TRANSPORT;
  });

  it("spawns `midplane server`, waits for /health, returns 127.0.0.1:<port>", async () => {
    const child = new FakeChild();
    child.exitOnSignal = "any";
    const spawn = vi.fn(() => child) as unknown as SpawnFn;
    const spawner = new ProcessSpawner({
      binaryPath: "midplane",
      spawn,
      fetch: okFetch,
      allocatePort: async () => 51999,
      indexerToken: "idx-tok",
    });

    const c = await spawner.spawn(spawnOpts());

    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(51999);
    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("midplane");
    expect(call[1]).toEqual(["server"]);

    await c.stop();
  });

  it("injects the per-project DSN as MIDPLANE_DSN_<id>, never DATABASE_URL, forwards allowlisted engine config, and isolates control-plane secrets", async () => {
    const child = new FakeChild();
    child.exitOnSignal = "any";
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawn = vi.fn((_cmd, _args, opts: { env: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      return child;
    }) as unknown as SpawnFn;

    const spawner = new ProcessSpawner({
      spawn,
      fetch: okFetch,
      allocatePort: async () => 52001,
      indexerToken: "idx-tok",
    });
    const c = await spawner.spawn(spawnOpts());

    expect(capturedEnv.MIDPLANE_DSN_01HXYZMAIN0000000000000000).toBe(
      "postgres://user:pw@localhost:5432/app",
    );
    expect(capturedEnv.PORT).toBe("52001");
    expect(capturedEnv.MIDPLANE_HOST).toBe("127.0.0.1");
    expect(capturedEnv.MIDPLANE_POLICY_FILE).toMatch(/policy\.yaml$/);
    expect(capturedEnv.DB_PATH).toMatch(/audit\.db$/);
    expect(capturedEnv.INDEXER_TOKEN).toBe("idx-tok");

    // Allowlisted engine config the operator set IS forwarded.
    expect(capturedEnv.MIDPLANE_TELEMETRY).toBe("0");

    // Spawn-managed vars WIN over an ambient value: the proxy speaks HTTP, so
    // an ambient MIDPLANE_TRANSPORT=stdio must not survive.
    expect(capturedEnv.MIDPLANE_TRANSPORT).toBe("http");

    // Control-plane secrets + the control-plane DATABASE_URL must NOT reach the
    // engine (it gets its DSN via MIDPLANE_DSN_<id>, never DATABASE_URL).
    expect(capturedEnv.DATABASE_URL).toBeUndefined();
    expect(capturedEnv.BETTER_AUTH_SECRET).toBeUndefined();

    await c.stop();
  });

  it("materializes the policy YAML and removes it on stop (teardown-no-orphans)", async () => {
    const child = new FakeChild();
    child.exitOnSignal = "SIGTERM";
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawn = vi.fn((_cmd, _args, opts: { env: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env;
      return child;
    }) as unknown as SpawnFn;

    const spawner = new ProcessSpawner({
      spawn,
      fetch: okFetch,
      allocatePort: async () => 52002,
      terminateGraceMs: 50,
    });
    const c = await spawner.spawn(spawnOpts());

    const policyPath = capturedEnv.MIDPLANE_POLICY_FILE!;
    await expect(access(policyPath)).resolves.toBeUndefined(); // exists now

    await c.stop();

    // Clean exit on SIGTERM — no SIGKILL escalation, no orphan.
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await expect(access(policyPath)).rejects.toThrow(); // removed
  });

  it("escalates to SIGKILL when SIGTERM is ignored on teardown", async () => {
    const child = new FakeChild(); // never exits on a signal
    const spawn = vi.fn(() => child) as unknown as SpawnFn;
    const spawner = new ProcessSpawner({
      spawn,
      fetch: okFetch,
      allocatePort: async () => 52003,
      terminateGraceMs: 30,
    });
    const c = await spawner.spawn(spawnOpts());

    await c.stop();
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("times out and tears down when /health never goes ready (startup-timeout)", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as unknown as SpawnFn;
    const failFetch = vi.fn(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;

    const spawner = new ProcessSpawner({
      spawn,
      fetch: failFetch,
      allocatePort: async () => 52004,
      bootTimeoutMs: 250,
      terminateGraceMs: 20,
    });

    await expect(spawner.spawn(spawnOpts())).rejects.toThrow(
      /did not become healthy within 250ms/,
    );
    // The child was torn down (no orphan left running after a failed boot).
    expect(child.killSignals[0]).toBe("SIGTERM");
  });

  it("surfaces an engine boot crash with its stderr, not a generic timeout (crash-surfaced-not-swallowed)", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      child.crash(1, "Configuration error: DATABASE_URL is required");
      return child;
    }) as unknown as SpawnFn;
    const connRefused = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const spawner = new ProcessSpawner({
      spawn,
      fetch: connRefused,
      allocatePort: async () => 52005,
      // Long boot budget: prove we fail FAST on exit, not after the timeout.
      bootTimeoutMs: 10_000,
    });

    const started = Date.now();
    await expect(spawner.spawn(spawnOpts())).rejects.toThrow(
      /exited before becoming healthy \(code=1.*Configuration error: DATABASE_URL is required/s,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("surfaces a missing binary with a helpful hint (ENOENT)", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      const err: NodeJS.ErrnoException = new Error("spawn midplane ENOENT");
      err.code = "ENOENT";
      child.emitSpawnError(err);
      return child;
    }) as unknown as SpawnFn;
    const connRefused = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const spawner = new ProcessSpawner({
      binaryPath: "midplane",
      spawn,
      fetch: connRefused,
      allocatePort: async () => 52006,
      bootTimeoutMs: 10_000,
    });

    await expect(spawner.spawn(spawnOpts())).rejects.toThrow(
      /failed to spawn.*MIDPLANE_ENGINE_BIN.*midplane/s,
    );
  });

  it("rejects a spawn with no databases", async () => {
    const spawner = new ProcessSpawner({
      spawn: (() => new FakeChild()) as unknown as SpawnFn,
      fetch: okFetch,
      allocatePort: async () => 52007,
    });
    await expect(
      spawner.spawn(spawnOpts({ databases: [] })),
    ).rejects.toThrow(/at least one database/);
  });
});
