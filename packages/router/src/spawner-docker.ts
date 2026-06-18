// DockerSpawner — local `docker run` of the OSS engine image.
//
// Used when FLY_API_TOKEN is absent (laptop dev, Playwright). One container
// per token. Container exposes 8080 inside; we bind it to a random host port
// and read the assignment back from `docker port`. Health is polled on
// http://127.0.0.1:<port>/health until the OSS server reports ready.
//
// stop() removes the container with --time=0 to keep teardown snappy in
// tests; in steady-state the idle timer in ContainerRegistry triggers this
// 30 minutes after the last request.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dsnEnvVarFor,
  serializeMultiDbPolicyToYaml,
} from "@midplane-cloud/db";

import { OSS_ENGINE_IMAGE } from "./oss-image.ts";
import type { SpawnedContainer, Spawner, SpawnOptions } from "./spawner.ts";

// Path inside the container where the OSS engine reads the policy file
// from. Matches the Fly spawner so the OSS image's MIDPLANE_POLICY_FILE
// env points at the same path regardless of backend.
const POLICY_FILE_GUEST_PATH = "/etc/midplane/policy.yaml";

export interface DockerSpawnerOptions {
  image?: string;
  /** Default 30s; raise on slow hosts. */
  bootTimeoutMs?: number;
  /** Shared bearer the audit indexer presents to the container's
   *  GET /audit/since endpoint. Injected as INDEXER_TOKEN env on the
   *  container so OSS can compare. Optional in dev — when absent, the
   *  container's audit endpoints stay 404. */
  indexerToken?: string;
  /** Injected for tests so we don't shell out. */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export class DockerSpawner implements Spawner {
  private readonly image: string;
  private readonly bootTimeoutMs: number;
  private readonly indexerToken: string | undefined;
  private readonly exec: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string }>;
  private readonly fetchFn: typeof fetch;

  constructor(opts: DockerSpawnerOptions = {}) {
    this.image = opts.image ?? process.env.MIDPLANE_OSS_IMAGE ?? OSS_ENGINE_IMAGE;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;
    this.indexerToken = opts.indexerToken;
    this.exec = opts.exec ?? execProcess;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async spawn(opts: SpawnOptions): Promise<SpawnedContainer> {
    if (opts.databases.length === 0) {
      throw new Error("DockerSpawner.spawn: at least one database required");
    }
    // Container name derived from the connection ULID. Docker rejects
    // uppercase in container names, so we lowercase the slice. Stable
    // for the connection's lifetime — siblings tokens on the same
    // connection share one container. Plaintext token is NEVER part of
    // the name (PR2 of mcp_url_auth_security).
    const name = `midplane-${opts.connectionId.slice(0, 16).toLowerCase()}`;
    // Materialize the multi-DB policy YAML to a host tempfile, bind-mount
    // it ro into the container at MIDPLANE_POLICY_FILE. The dir is per-
    // spawn so a concurrent spawn for a different token can't observe or
    // clobber. Cleaned up in stop(); a leak survives until OS tmp eviction.
    // The YAML is non-secret — DSNs are NOT inlined; each `url:` references
    // an env var the spawner injects below.
    const policyDir = await mkdtemp(join(tmpdir(), "midplane-policy-"));
    const policyHostPath = join(policyDir, "policy.yaml");
    await writeFile(
      policyHostPath,
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

    // -p 0:8080 asks Docker for a random host port; -d --rm so the container
    // self-removes on stop. DSNs are injected as MIDPLANE_DSN_<id> env vars
    // (one per DB) — they live in the container's env, never on disk. The
    // YAML's `databases[].url` references each via ${...} interpolation
    // (OSS 0.2.0 ENV_INTERP_RE).
    const args = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "PORT=8080",
      "-e",
      `MIDPLANE_POLICY_FILE=${POLICY_FILE_GUEST_PATH}`,
      "-v",
      `${policyHostPath}:${POLICY_FILE_GUEST_PATH}:ro`,
    ];
    for (const db of opts.databases) {
      args.push("-e", `${dsnEnvVarFor(db.connectionDatabaseId)}=${db.dsn}`);
    }
    if (this.indexerToken) {
      args.push("-e", `INDEXER_TOKEN=${this.indexerToken}`);
    }
    args.push("-p", "0:8080", this.image);
    let containerId: string;
    try {
      const runRes = await this.exec("docker", args);
      containerId = runRes.stdout.trim();
      if (!containerId) throw new Error("docker run returned empty container id");
    } catch (err) {
      await rm(policyDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    let port: number;
    try {
      const portRes = await this.exec("docker", ["port", containerId, "8080"]);
      port = parseHostPort(portRes.stdout);
      await this.waitForHealth(port);
    } catch (err) {
      await this.exec("docker", ["rm", "-f", containerId]).catch(() => undefined);
      await rm(policyDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    const exec = this.exec;
    return {
      host: "127.0.0.1",
      port,
      async stop() {
        await exec("docker", ["stop", "--time=0", containerId]).catch(
          () => undefined,
        );
        await rm(policyDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  private async waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + this.bootTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
        lastErr = new Error(`health returned ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(200);
    }
    throw new Error(
      `OSS image did not become healthy within ${this.bootTimeoutMs}ms: ${String(lastErr)}`,
    );
  }
}

// Parse `0.0.0.0:32768\n[::]:32768\n` etc. Take the first IPv4 mapping.
export function parseHostPort(stdout: string): number {
  const lines = stdout.trim().split(/\r?\n/);
  for (const line of lines) {
    const m = /(?:\d+\.\d+\.\d+\.\d+|::):(\d+)$/.exec(line.trim());
    if (m && m[1]) return Number(m[1]);
  }
  throw new Error(`could not parse host port from: ${stdout}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function execProcess(
  cmd: string,
  args: string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString("utf8") });
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
      }
    });
  });
}
