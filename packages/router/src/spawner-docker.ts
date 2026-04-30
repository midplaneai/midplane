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

import type { SpawnedContainer, Spawner, SpawnOptions } from "./spawner.ts";

export interface DockerSpawnerOptions {
  image?: string;
  /** Default 30s; raise on slow hosts. */
  bootTimeoutMs?: number;
  /** Injected for tests so we don't shell out. */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export class DockerSpawner implements Spawner {
  private readonly image: string;
  private readonly bootTimeoutMs: number;
  private readonly exec: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string }>;
  private readonly fetchFn: typeof fetch;

  constructor(opts: DockerSpawnerOptions = {}) {
    this.image = opts.image ?? process.env.MIDPLANE_OSS_IMAGE ?? "midplane/midplane:0.1.0";
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;
    this.exec = opts.exec ?? execProcess;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async spawn(opts: SpawnOptions): Promise<SpawnedContainer> {
    const name = `midplane-${opts.token.slice(0, 16)}`;
    // -p 0:8080 asks Docker for a random host port; -d --rm so the container
    // self-removes on stop. DATABASE_URL is the only place the decrypted DSN
    // surfaces; it lives in the container's env, not on disk.
    const runRes = await this.exec("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      `DATABASE_URL=${opts.dsn}`,
      "-e",
      "PORT=8080",
      "-p",
      "0:8080",
      this.image,
    ]);
    const containerId = runRes.stdout.trim();
    if (!containerId) throw new Error("docker run returned empty container id");

    let port: number;
    try {
      const portRes = await this.exec("docker", ["port", containerId, "8080"]);
      port = parseHostPort(portRes.stdout);
      await this.waitForHealth(port);
    } catch (err) {
      await this.exec("docker", ["rm", "-f", containerId]).catch(() => undefined);
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
