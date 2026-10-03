// The `midplane` command itself: keygen and token produce a working pair,
// `local --stdio` serves MCP over stdin/stdout for a verified token, and
// `setup`, answered line by line, tests each connection string, writes a
// gateway's folder, enrolls and serves.

import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLinkedConfig } from "../src/config.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
import {
  checksPasswords,
  createDatabase,
  hasPostgres,
  type TestDatabase,
  wrongPassword,
} from "./harness.ts";

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

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  ms = 15_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every file under `dir`, by path. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(!hasPostgres)("midplane setup", { timeout: 60_000 }, () => {
  let db: TestDatabase;
  let cloud: FakeCloud;
  let base: string;

  beforeAll(async () => {
    db = await createDatabase(
      "CREATE TABLE notes (id int PRIMARY KEY, body text); CREATE TABLE users (id int, email text);",
      (role) => `GRANT SELECT ON notes, users TO ${role};`,
    );
    // The project has `main` already.
    cloud = await startFakeCloud({ databases: ["main"] });
    base = mkdtempSync(join(tmpdir(), "midplane-setup-"));
  }, 60_000);

  afterAll(async () => {
    await cloud?.close();
    await db?.drop();
  });

  /** Setup with these answers, one per line, then the end of input. */
  const start = (args: string[], answers: string[]) => {
    const child = spawn(
      process.execPath,
      [CLI, "setup", "--cloud", cloud.url, ...args],
      { cwd: base },
    );
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (d) => {
      out.stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      out.stderr += String(d);
    });
    child.stdin.end(answers.map((a) => `${a}\n`).join(""));
    const exited = new Promise<number | null>((done) =>
      child.on("exit", (code) => done(code)),
    );
    return { child, out, exited };
  };
  const run = async (args: string[], answers: string[]) => {
    const s = start(args, answers);
    const code = await s.exited;
    return { code, ...s.out };
  };

  it("asks again after a wrong password, then writes the folder and enrolls", async (ctx) => {
    if (!(await checksPasswords(db))) ctx.skip();
    const r = await run(
      [
        "--token",
        cloud.enrollmentToken(),
        "--database",
        "main",
        "--dir",
        "first",
        "--port",
        String(await freePort()),
        "--no-start",
      ],
      [wrongPassword(db), db.agentDsn, ""],
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Connection string for main (Enter to skip): \n  password authentication failed (28P01)\n",
    );
    expect(r.stdout).toMatch(
      new RegExp(`ok: database ${db.name} on [^,]+, 2 tables`),
    );
    expect(r.stdout).toContain("Already in Test project: main.");

    const dir = join(base, "first");
    const config = loadLinkedConfig(join(dir, "midplane.yaml"), {});
    expect(config.databases.get("main")?.dsn).toBe(db.agentDsn);
    expect(mode(join(dir, "secrets"))).toBe(0o700);
    for (const f of [
      "secrets/main.dsn",
      "secrets/mask-salt",
      "identity.json",
    ]) {
      expect(mode(join(dir, f)), f).toBe(0o600);
    }
    const enrolled = JSON.parse(
      cloud.bodies.findLast((b) => b.path === "/link/v1/enroll")?.body ?? "{}",
    );
    expect(enrolled.databases).toEqual(["main"]);
  });

  it("keeps a connection string that fails, serves the rest, and leaks none of them", async () => {
    const locked = await checksPasswords(db);
    // Without a password check to fail, a port nothing answers on.
    const bad = locked
      ? wrongPassword(db)
      : `postgres://${db.role}:not-the-password@127.0.0.1:1/${db.name}`;
    const token = cloud.enrollmentToken();
    const s = start(
      ["--token", token, "--dir", "second"],
      ["", db.agentDsn, "", "y", bad, "keep", "locked", "n"],
    );
    try {
      const id = db.name; // its name, suggested and taken
      await waitFor("health for both databases", () => {
        const h = cloud.statuses.at(-1)?.database_health;
        return Boolean(h?.[id]?.ok && h.locked);
      });
      expect(s.out.stdout).toContain(
        `  ${locked ? "password authentication failed (28P01)" : "connection refused (ECONNREFUSED)"}\n`,
      );
      expect(s.out.stdout).toContain(
        `Added to Test project: ${id}, locked. Nothing in them is readable until a policy is published.`,
      );
      expect(cloud.statuses.at(-1)?.database_health?.locked).toMatchObject({
        ok: false,
        code: locked ? "28P01" : "ECONNREFUSED",
      });
      await waitFor("its catalog", () => cloud.catalogs.has(id));

      // Another gateway set up here meanwhile takes the next port.
      const dir = join(base, "second");
      const first = loadLinkedConfig(join(dir, "midplane.yaml"), {}).listen
        .port;
      const next = await run(
        ["--token", cloud.enrollmentToken(), "--dir", "third", "--no-start"],
        ["", db.agentDsn, "", "n"],
      );
      expect(next.code).toBe(0);
      const second = loadLinkedConfig(join(base, "third", "midplane.yaml"), {})
        .listen.port;
      expect(first).toBeGreaterThanOrEqual(7433);
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThanOrEqual(7442);

      // Invariant 9, from the first question on: no connection string, nor
      // its password, in what setup and the gateway print, in any file but
      // its own, or in anything sent to the cloud.
      const secrets = [
        db.agentDsn,
        new URL(db.agentDsn).password,
        bad,
        "not-the-password",
      ];
      const dsnFiles = new Set([
        join(dir, "secrets", `${id}.dsn`),
        join(dir, "secrets", "locked.dsn"),
      ]);
      const places = [
        { where: "stdout", text: s.out.stdout },
        { where: "stderr", text: s.out.stderr },
        ...filesIn(dir)
          .filter((f) => !dsnFiles.has(f))
          .map((f) => ({ where: f, text: readFileSync(f, "latin1") })),
        ...cloud.bodies.map((b) => ({ where: b.path, text: b.body })),
      ];
      expect(places.some((p) => p.where.endsWith("audit.db"))).toBe(true);
      for (const { where, text } of places) {
        for (const secret of secrets) {
          expect(text, `${where} holds ${secret}`).not.toContain(secret);
        }
      }
    } finally {
      s.child.kill("SIGTERM");
    }
    expect(await s.exited).toBe(0);
  });

  it("leaves nothing behind after the input ends or the cloud refuses, and the token unused", async () => {
    const token = cloud.enrollmentToken();
    const args = async (dir: string, t = token) => [
      "--token",
      t,
      "--dir",
      dir,
      "--port",
      String(await freePort()),
      "--no-start",
    ];
    // The input ends at each question in turn.
    for (const answers of [
      [],
      ["y"],
      ["y", db.agentDsn],
      ["y", db.agentDsn, ""],
    ]) {
      const r = await run(await args("ended"), answers);
      expect(r.code, answers.join(" | ")).toBe(1);
      expect(r.stderr).toContain(
        "The input ended before setup wrote anything; the token is unused.",
      );
      expect(existsSync(join(base, "ended"))).toBe(false);
    }

    // A container's volume: refused, it is left as it was, empty.
    mkdirSync(join(base, "volume"));
    const refused = await run(await args("volume", `mpe1_${"A".repeat(86)}`), [
      "y",
      db.agentDsn,
      "",
      "n",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "enrollment refused (401): unknown token\nSetup removed the files it wrote.\n",
    );
    expect(readdirSync(join(base, "volume"))).toEqual([]);

    // The token was never spent. A --database id skipped can't name
    // another database: the project's policy for it would govern this one.
    const ok = await run(
      [...(await args("volume")), "--database", "main"],
      ["", "y", db.agentDsn, "main", "store", "n"],
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(
      "  main is named by --database; choose another name\n",
    );
    expect(readdirSync(join(base, "volume")).sort()).toEqual([
      "identity.json",
      "midplane.yaml",
      "secrets",
    ]);
    expect([
      ...loadLinkedConfig(
        join(base, "volume", "midplane.yaml"),
        {},
      ).databases.keys(),
    ]).toEqual(["store"]);
  });
});
