// The `midplane` command itself: keygen and token produce a working pair, and
// `local --stdio` serves MCP over stdin/stdout for a verified token.

import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, hasPostgres, type TestDatabase } from "./harness.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe.skipIf(!hasPostgres)("midplane command", () => {
  let db: TestDatabase;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    db = await createDatabase(
      "CREATE TABLE notes (id int PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'hello');",
      (role) => `GRANT SELECT ON notes TO ${role};`,
    );
    dir = mkdtempSync(join(tmpdir(), "midplane-cli-"));
    execFileSync(process.execPath, [CLI, "keygen", "--out", dir]);
    writeFileSync(
      join(dir, "midplane.yaml"),
      [
        "auth:",
        "  issuer: midplane-local",
        "  public_key_file: midplane-verify-key.json",
        "audit: { file: audit.db }",
        "databases:",
        "  main:",
        "    dsn: { env: NOTES_DSN }",
        "    policy: { table_access: { default: read } }",
        "",
      ].join("\n"),
    );
    env = { ...process.env, NOTES_DSN: db.agentDsn };
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const token = (extra: string[] = []) =>
    execFileSync(
      process.execPath,
      [
        CLI,
        "token",
        "--config",
        join(dir, "midplane.yaml"),
        "--key",
        join(dir, "midplane-signing-key.json"),
        "--sub",
        "cli-user",
        ...extra,
      ],
      { env },
    )
      .toString()
      .trim();

  it("mints a token the gateway accepts, and serves MCP over stdio", async () => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [CLI, "local", "--config", join(dir, "midplane.yaml"), "--stdio"],
      { env: { ...env, MIDPLANE_TOKEN: token() } },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("exit", (code) => {
      const w = waiters.shift();
      if (w) w({ exited: code, stderr });
    });
    const lines = createInterface({ input: child.stdout });
    const replies: unknown[] = [];
    const waiters: ((v: unknown) => void)[] = [];
    lines.on("line", (l) => {
      const w = waiters.shift();
      if (w) w(JSON.parse(l));
      else replies.push(JSON.parse(l));
    });
    const next = () =>
      new Promise((resolve) => {
        const r = replies.shift();
        if (r) resolve(r);
        else waiters.push(resolve);
      });
    const send = (msg: unknown) =>
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      expect(await next()).toMatchObject({
        id: 1,
        result: { serverInfo: { name: "midplane" } },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "query", arguments: { sql: "SELECT body FROM notes" } },
      });
      expect(await next()).toMatchObject({
        id: 2,
        result: { structuredContent: { rows: [["hello"]] } },
      });
    } finally {
      child.kill();
    }
  }, 30_000);

  it("won't start over stdio with a token it can't verify", () => {
    const run = () =>
      execFileSync(
        process.execPath,
        [CLI, "local", "--config", join(dir, "midplane.yaml"), "--stdio"],
        {
          env: { ...env, MIDPLANE_TOKEN: `${token()}x` },
          stdio: "pipe",
        },
      );
    expect(run).toThrow();
  });

  it("won't start without the salt when a database has masks", () => {
    const masked = join(dir, "masked.yaml");
    writeFileSync(
      masked,
      [
        "auth: { issuer: midplane-local, public_key_file: midplane-verify-key.json }",
        "audit: { file: audit2.db }",
        "databases:",
        "  main:",
        "    dsn: { env: NOTES_DSN }",
        "    policy: { masks: { public.notes: { body: full-redact } } }",
        "",
      ].join("\n"),
    );
    let stderr = "";
    try {
      execFileSync(process.execPath, [CLI, "local", "--config", masked], {
        env,
        stdio: "pipe",
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr);
    }
    expect(stderr).toContain("mask_salt is required");
  });
});
