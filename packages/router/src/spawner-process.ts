// ProcessSpawner — self-host backend.
//
// In self-host (MIDPLANE_SELF_HOST=1) the control plane runs on one box
// against one Postgres with NO Fly and NO host Docker daemon. Instead of
// `docker run`-ing the OSS image (DockerSpawner) or creating a Fly machine
// (FlyMachineSpawner), it exec's the self-contained compiled engine binary
// (`midplane server`, the `bun build --compile` artifact shipped inside the
// self-host image) as a child process — one process per CONNECTION, bound to
// a loopback-only ephemeral port. The proxy reaches it at 127.0.0.1:<port>.
//
// Why one process PER CONNECTION (not one standing engine): the engine binds
// exactly one set of databases for its lifetime — the policy file + the
// MIDPLANE_DSN_* env vars are read once at boot. Collapsing to a single
// standing engine would require an engine change (dynamic per-request DSN
// selection); the spawn-per-connection model is identical to the Docker/Fly
// backends and reuses the same ContainerRegistry (keyed on connection_id,
// 30-minute idle stop).
//
// Trust posture: the engine subprocess gets a CURATED env, not the control
// plane's full environment. It receives only what it needs to boot (PORT,
// bind host, policy file, per-DB DSNs, the audit DB path, the indexer token)
// plus PATH/HOME so the binary can be found and run. The control plane's own
// secrets (BETTER_AUTH_SECRET, KMS key material, the control-plane
// DATABASE_URL) are NOT inherited — mirroring the isolation a container's
// fresh env gives the Docker/Fly backends. The per-connection DSN is injected
// the same way (MIDPLANE_DSN_<id> env var, referenced from the YAML via
// ${...}); it never touches disk.

import { spawn as nodeSpawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dsnEnvVarFor,
  serializeMultiDbPolicyToYaml,
} from "@midplane-cloud/db";

import type { SpawnedContainer, Spawner, SpawnOptions } from "./spawner.ts";

// Loopback bind. The engine is reachable only from this host — there is no
// 6PN/anycast layer in self-host, so binding to 127.0.0.1 keeps the customer's
// raw-DSN-holding engine off every other interface.
const ENGINE_HOST = "127.0.0.1";

// Documented engine runtime config forwarded from the control plane's env into
// each spawned engine (when set). This is an ALLOWLIST, not a passthrough of
// process.env: it keeps the operator's documented engine knobs working —
// telemetry opt-out (MIDPLANE_TELEMETRY / DO_NOT_TRACK), deny-notification
// webhook, log level — while the control plane's own secrets (DATABASE_URL,
// BETTER_AUTH_SECRET, KMS / token-pepper material, FLY_API_TOKEN, …) stay out
// of the engine's env. Spawn-managed vars (PORT, MIDPLANE_HOST,
// MIDPLANE_TRANSPORT, MIDPLANE_POLICY_FILE, DB_PATH, INDEXER_TOKEN,
// MIDPLANE_DSN_*) are deliberately NOT here — the spawner sets those itself and
// they must win over anything ambient (a stray MIDPLANE_TRANSPORT=stdio would
// otherwise break the HTTP proxy). Exported for the unit suite.
export const ENGINE_CONFIG_PASSTHROUGH = [
  "MIDPLANE_TELEMETRY",
  "MIDPLANE_TELEMETRY_ENDPOINT",
  "MIDPLANE_TELEMETRY_HEARTBEAT_MS",
  "MIDPLANE_TELEMETRY_STARTUP_DELAY_MS",
  "DO_NOT_TRACK",
  "MIDPLANE_DENY_WEBHOOK",
  "MIDPLANE_DENY_WEBHOOK_RULES",
  "MIDPLANE_TENANT_ID",
  "LOG_LEVEL",
  "NO_COLOR",
] as const;

/** Minimal child-process surface the spawner depends on. node's ChildProcess
 *  satisfies it; tests pass a fake so no real process is forked. */
export interface ChildHandle {
  readonly pid?: number;
  killed: boolean;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "error", cb: (err: Error) => void): void;
  on(
    event: "exit",
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildHandle;

export interface ProcessSpawnerOptions {
  /** The compiled engine binary. Defaults to MIDPLANE_ENGINE_BIN, else
   *  `midplane` (resolved on PATH — the self-host image installs it at
   *  /usr/local/bin/midplane). A missing binary surfaces as a clear spawn
   *  error, not a silent timeout. */
  binaryPath?: string;
  /** Default 30s. Covers process fork + the engine binding its port +
   *  /health answering. */
  bootTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on teardown. Default 5s — the engine
   *  installs a SIGTERM handler that closes the HTTP server + audit DB and
   *  exits 0, so the grace is rarely consumed. */
  terminateGraceMs?: number;
  /** Shared bearer the audit indexer presents to the engine's
   *  GET /audit/since endpoint. Injected as INDEXER_TOKEN so the engine
   *  exposes its audit endpoints. Optional — when absent the engine's
   *  /audit routes 404 and no audit reaches the dashboard (the self-host
   *  selector in mcp-proxy.ts auto-provisions a loopback token so this is
   *  set in practice). */
  indexerToken?: string;
  /** Injected for tests so no real process is forked. */
  spawn?: SpawnFn;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Allocate a free local TCP port. Default asks the OS for an ephemeral
   *  port (bind :0, read it back, release). Injected in tests to force a
   *  specific port. */
  allocatePort?: () => Promise<number>;
}

export class ProcessSpawner implements Spawner {
  private readonly binaryPath: string;
  private readonly bootTimeoutMs: number;
  private readonly terminateGraceMs: number;
  private readonly indexerToken: string | undefined;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: typeof fetch;
  private readonly allocatePort: () => Promise<number>;

  constructor(opts: ProcessSpawnerOptions = {}) {
    this.binaryPath =
      opts.binaryPath ?? process.env.MIDPLANE_ENGINE_BIN ?? "midplane";
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;
    this.terminateGraceMs = opts.terminateGraceMs ?? 5_000;
    this.indexerToken = opts.indexerToken;
    // stdin ignored; stdout/stderr piped so we can drain them (an undrained
    // pipe buffer would deadlock a chatty engine) and surface boot-crash
    // output. The control plane never reads the engine's stdout otherwise.
    this.spawnFn =
      opts.spawn ??
      ((cmd, args, options) =>
        nodeSpawn(cmd, args, {
          env: options.env,
          stdio: ["ignore", "pipe", "pipe"],
        }) as unknown as ChildHandle);
    this.fetchFn = opts.fetch ?? fetch;
    this.allocatePort = opts.allocatePort ?? allocateFreePort;
  }

  async spawn(opts: SpawnOptions): Promise<SpawnedContainer> {
    if (opts.databases.length === 0) {
      throw new Error("ProcessSpawner.spawn: at least one database required");
    }

    const port = await this.allocatePort();

    // Materialize the multi-DB policy YAML to a per-spawn tempdir (read by the
    // engine via MIDPLANE_POLICY_FILE). Non-secret — DSNs are NOT inlined;
    // each `url:` references a MIDPLANE_DSN_<id> env var via ${...}.
    const policyDir = await mkdtemp(join(tmpdir(), "midplane-policy-"));
    const policyPath = join(policyDir, "policy.yaml");
    await writeFile(
      policyPath,
      serializeMultiDbPolicyToYaml(
        opts.databases.map((db) => ({
          name: db.name,
          connectionDatabaseId: db.connectionDatabaseId,
          tableAccess: db.tableAccess,
          tenantScope: db.tenantScope,
          guardrails: db.guardrails,
        })),
      ),
      { mode: 0o644 },
    );

    // Per-spawn audit SQLite. The engine's DB_PATH default is /data/audit.db,
    // which won't exist/be writable on an arbitrary self-host box, and two
    // engines must never share one file — so give each its own tempdir. The
    // indexer drains it over HTTP, so it's transient; removed on stop().
    const dataDir = await mkdtemp(join(tmpdir(), "midplane-engine-"));
    const dbPath = join(dataDir, "audit.db");

    // Curated env — NOT the control plane's full environment. Start with
    // run/binary-lookup essentials plus the allowlisted engine config the
    // operator set; then layer the spawn-managed vars on top so THEY win.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    for (const key of ENGINE_CONFIG_PASSTHROUGH) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Spawn-managed (set AFTER the passthrough so an ambient value can't win).
    env.NODE_ENV = "production";
    env.PORT = String(port);
    env.MIDPLANE_HOST = ENGINE_HOST;
    env.MIDPLANE_TRANSPORT = "http"; // the proxy speaks HTTP to the engine
    env.MIDPLANE_POLICY_FILE = policyPath;
    env.DB_PATH = dbPath;
    for (const db of opts.databases) {
      env[dsnEnvVarFor(db.connectionDatabaseId)] = db.dsn;
    }
    if (this.indexerToken) env.INDEXER_TOKEN = this.indexerToken;

    const child = this.spawnFn(this.binaryPath, ["server"], { env });

    // Drain BOTH streams (prevents a pipe-buffer deadlock) and keep the tail so
    // a crash surfaces the real reason instead of a generic timeout. Config
    // errors go to stderr; structured/telemetry logs to stdout — capture
    // either. Bounded so a chatty engine can't grow this without limit.
    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 8192) output = output.slice(-8192);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    let spawnError: Error | null = null;
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => (resolveExit = r));
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolveExit();
    });
    child.on("error", (err) => {
      spawnError = err;
      resolveExit();
    });

    const cleanupFiles = async () => {
      await rm(policyDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
      await this.waitForHealth(port, {
        getSpawnError: () => spawnError,
        getExit: () => exit,
        getOutput: () => output,
      });
    } catch (err) {
      await this.terminate(child, exited, () => exit !== null);
      await cleanupFiles();
      throw err;
    }

    const self = this;
    return {
      host: ENGINE_HOST,
      port,
      async stop() {
        await self.terminate(child, exited, () => exit !== null);
        await cleanupFiles();
      },
    };
  }

  // Poll /health until the engine answers 2xx. Short-circuits the instant the
  // child fails to spawn (e.g. binary not found) or exits before becoming
  // healthy (config error, port collision, crash) — so a dead engine fails
  // fast with its stderr attached rather than burning the full timeout.
  private async waitForHealth(
    port: number,
    sig: {
      getSpawnError: () => Error | null;
      getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
      getOutput: () => string;
    },
  ): Promise<void> {
    const deadline = Date.now() + this.bootTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      const spawnError = sig.getSpawnError();
      if (spawnError) {
        const hint =
          (spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? ` (is the engine binary on PATH, or MIDPLANE_ENGINE_BIN set? tried "${this.binaryPath}")`
            : "";
        throw new Error(
          `engine process failed to spawn${hint}: ${spawnError.message}`,
        );
      }
      const exit = sig.getExit();
      if (exit) {
        throw new Error(
          `engine process exited before becoming healthy ` +
            `(code=${exit.code} signal=${exit.signal}): ${sig.getOutput().trim()}`,
        );
      }
      try {
        const res = await this.fetchFn(`http://${ENGINE_HOST}:${port}/health`);
        if (res.ok) return;
        lastErr = new Error(`health returned ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(200);
    }
    throw new Error(
      `engine did not become healthy within ${this.bootTimeoutMs}ms: ${String(lastErr)}`,
    );
  }

  // Graceful stop: SIGTERM, wait up to the grace for a clean exit, then
  // SIGKILL. Idempotent and safe to call on an already-exited child (kill on
  // a reaped pid is a no-op / throws ENVALID which we swallow). Guarantees no
  // orphaned engine survives a connection teardown or idle expiry.
  private async terminate(
    child: ChildHandle,
    exited: Promise<void>,
    hasExited: () => boolean,
  ): Promise<void> {
    if (hasExited()) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const cleanly = await Promise.race([
      exited.then(() => true),
      sleep(this.terminateGraceMs).then(() => false),
    ]);
    if (cleanly || hasExited()) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    // Best-effort reap; don't hang teardown if SIGKILL is somehow ignored.
    await Promise.race([exited, sleep(2_000)]);
  }
}

/** Ask the OS for a free ephemeral TCP port: bind :0 on loopback, read the
 *  assigned port, release it. There is an unavoidable TOCTOU window between
 *  release and the engine binding it — if something else grabs the port the
 *  engine exits with a bind error, which waitForHealth surfaces (and the
 *  caller retries on the next request). Exported for the unit suite. */
export async function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, ENGINE_HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a free port")));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
