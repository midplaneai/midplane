// `midplane gateway` as a real process: the wiring in gateway/run.ts, not just
// its parts. Spawns the CLI against the fake control plane.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCloud } from "./_fake-cloud.ts";

const CLI = join(import.meta.dirname, "../../src/cli.ts");
const MAIN_ENV = "MIDPLANE_DSN_01MAINAAAAAAAAAAAAAAAAAAAA";

const POLICY = [
  "databases:",
  "  - name: main",
  `    url: \${${MAIN_ENV}}`,
  "    table_access:",
  "      default: read",
  "      tables: {}",
  "    guardrails:",
  "      block_unqualified_dml: true",
  "      block_ddl: true",
  "",
].join("\n");

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function run(env: Record<string, string>): { child: ChildProcess; exit: Promise<number | null>; stderr: () => string } {
  const child = spawn(process.execPath, [CLI, "gateway"], {
    // A clean environment: nothing from the test runner's shell (a stray
    // DATABASE_URL would — correctly — be refused).
    env: { PATH: process.env.PATH ?? "", DO_NOT_TRACK: "1", MIDPLANE_TELEMETRY: "off", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d) => (err += String(d)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, stderr: () => err };
}

describe("midplane gateway (process)", () => {
  let cloud: FakeCloud;
  let dir: string;
  let children: ChildProcess[] = [];

  beforeEach(async () => {
    cloud = await FakeCloud.start();
    dir = mkdtempSync(join(tmpdir(), "midplane-gw-cli-"));
  });

  afterEach(async () => {
    for (const c of children) c.kill("SIGKILL");
    children = [];
    await cloud.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function baseEnv(port: number): Record<string, string> {
    return {
      HOME: dir,
      MIDPLANE_CLOUD_URL: cloud.origin,
      MIDPLANE_MASK_SALT: "s".repeat(32),
      MIDPLANE_GATEWAY_STATE_DIR: join(dir, "state"),
      DB_PATH: join(dir, "audit.db"),
      PORT: String(port),
      [MAIN_ENV]: "postgres://gateway@127.0.0.1:1/app",
    };
  }

  test("refuses to start on a non-loopback address", async () => {
    const p = run({ ...baseEnv(await freePort()), MIDPLANE_HOST: "0.0.0.0", MIDPLANE_ENROLL_TOKEN: cloud.mintToken() });
    children.push(p.child);
    expect(await p.exit).toBe(1);
    expect(p.stderr()).toContain("not a loopback address");
    expect(cloud.requests).toHaveLength(0); // refused before calling out
  });

  test("enrolls, pulls the bundle, reports healthy, heartbeats, and shuts down cleanly", async () => {
    cloud.publish(POLICY);
    const port = await freePort();
    const p = run({ ...baseEnv(port), MIDPLANE_ENROLL_TOKEN: cloud.mintToken() });
    children.push(p.child);

    let health: { status: number; body: Record<string, unknown> } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        health = { status: res.status, body: (await res.json()) as Record<string, unknown> };
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(health).toMatchObject({ status: 200, body: { state: "serving", bundle_version: 1 } });

    const hbDeadline = Date.now() + 5_000;
    while (!cloud.heartbeats.some((h) => h.state === "serving") && Date.now() < hbDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(cloud.heartbeats.some((h) => h.state === "serving")).toBe(true);
    expect(cloud.requests).toContain("POST /api/gateway/v1/enroll");

    p.child.kill("SIGTERM");
    expect(await p.exit).toBe(0);
  }, 30_000);
});
