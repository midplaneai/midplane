// What `npx midplane` and the container image really do, from the artifacts
// a release publishes. Packs the gateway (or takes a tarball), installs it
// with npm into an empty directory, then:
//
//   1. runs the local quickstart exactly as its README says (keygen, token,
//      local) against the quickstart's database, and asks what the README
//      asks;
//   2. enrolls and runs linked mode (`midplane enroll`, `midplane gateway`)
//      against the tests' stand-in cloud: a bundle, a query, its audit push;
//      then `midplane setup`, answered on stdin, which tests the connection
//      string, writes the folder, enrolls and serves;
//   3. with --image, runs the image's `midplane local --stdio` on the
//      quickstart's Docker network, as its non-root user; and on Linux,
//      `setup` and `gateway` in the image with every secret on a volume and
//      nothing on the host but the TLS folder, served over TLS.
//
// Needs the quickstart's database: `docker compose -f
// examples/quickstart/compose.yaml up -d --wait` (from oss/).
//
//   node apps/gateway/scripts/package-smoke.ts [--tarball <file>] [--image <tag>]

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { startFakeCloud } from "../test/fake-cloud.ts";

const GATEWAY = resolve(import.meta.dirname, "..");
const OSS = resolve(GATEWAY, "..", "..");
const QUICKSTART = join(OSS, "examples", "quickstart");
const SHOP_DSN = "postgres://midplane_agent:quickstart@127.0.0.1:54329/shop";
const SHOP_DSN_IN_DOCKER =
  "postgres://midplane_agent:quickstart@postgres:5432/shop";

const { values } = parseArgs({
  options: { tarball: { type: "string" }, image: { type: "string" } },
});

function step(msg: string): void {
  process.stdout.write(`\n▸ ${msg}\n`);
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`smoke check failed: ${what}`);
  process.stdout.write(`  ✓ ${what}\n`);
}

async function waitFor(
  what: string,
  test: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await test()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A POST's answer, over https with this CA when one is given. */
async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  ca?: string,
): Promise<string> {
  if (!ca) return (await fetch(url, { method: "POST", headers, body })).text();
  return new Promise((done, fail) => {
    const req = httpsRequest(url, { method: "POST", headers, ca }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        raw += d;
      });
      res.on("end", () => done(raw));
    });
    req.on("error", fail);
    req.end(body);
  });
}

/** One MCP tools/call over HTTP, the 2025 handshake. */
async function call(
  url: string,
  token: string,
  sql: string,
  ca?: string,
): Promise<{ isError: boolean; text: string }> {
  const raw = await post(
    url,
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      authorization: `Bearer ${token}`,
    },
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query", arguments: { sql } },
    }),
    ca,
  );
  const json = raw.startsWith("{")
    ? raw
    : (raw
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5) ?? "null");
  const result = (
    JSON.parse(json) as {
      result?: { isError?: boolean; content: { text: string }[] };
    }
  ).result;
  if (!result) throw new Error(`no result: ${raw}`);
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text).join("\n"),
  };
}

/**
 * SIGTERM, then SIGKILL after 10 s, so a gateway that won't stop can't hang
 * the run. Never throws: a failed check in the caller stays the error, and
 * `checkStopped` reports the exit after.
 */
function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(kill);
      done();
    });
    child.kill("SIGTERM");
  });
}

/** The gateway closed and exited 0 on SIGTERM, not killed after 10 s. */
function checkStopped(child: ChildProcess, what: string): void {
  if (child.exitCode !== 0) {
    process.stdout.write(
      `  ${what}: exit code ${child.exitCode}, signal ${child.signalCode}\n`,
    );
  }
  check(child.exitCode === 0, `${what} stops on SIGTERM`);
}

// ── the package ───────────────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "midplane-smoke-"));
let tarball = values.tarball ? resolve(values.tarball) : "";
if (!tarball) {
  step("build and pack the gateway");
  execFileSync("node", ["scripts/build.ts"], {
    cwd: GATEWAY,
    stdio: "inherit",
  });
  const out = join(work, "pack");
  mkdirSync(out);
  execFileSync("pnpm", ["pack", "--pack-destination", out], {
    cwd: GATEWAY,
    stdio: "inherit",
  });
  const [file] = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  tarball = join(out, file as string);
}
const version = (
  JSON.parse(readFileSync(join(GATEWAY, "package.json"), "utf8")) as {
    version: string;
  }
).version;

step(`install ${tarball} with npm into an empty directory`);
const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), '{ "private": true }\n');
execFileSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
  { cwd: app, stdio: "inherit" },
);
const bin = join(app, "node_modules", ".bin", "midplane");
const midplane = (args: string[], o: { cwd?: string; env?: object } = {}) =>
  execFileSync(bin, args, {
    cwd: o.cwd ?? app,
    env: { ...process.env, ...o.env },
    timeout: 60_000,
  }).toString();
/** Run it without blocking: the stand-in cloud answers from this process. */
const midplaneAsync = (
  args: string[],
  o: { cwd: string; env: object },
): Promise<string> =>
  new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`midplane ${args[0]}: exit ${code}`)),
    );
  });
check(
  midplane(["--version"]).trim() === `midplane ${version}`,
  `midplane --version says ${version}`,
);

// ── 1. the local quickstart, as its README says ───────────────────────────

step("the local quickstart");
const qs = join(work, "quickstart");
cpSync(QUICKSTART, qs, { recursive: true });
const salt = randomBytes(32).toString("hex");
const env = { SHOP_DSN, MIDPLANE_MASK_SALT: salt };
midplane(["keygen", "--out", "."], { cwd: qs });
const localToken = midplane(
  [
    "token",
    "--config",
    "midplane.yaml",
    "--key",
    "midplane-signing-key.json",
    "--sub",
    "you@example.com",
    "--access",
    "write",
  ],
  { cwd: qs, env },
).trim();
const local = spawn(bin, ["local", "--config", "midplane.yaml"], {
  cwd: qs,
  env: { ...process.env, ...env },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  const url = "http://127.0.0.1:7433/mcp";
  await waitFor(
    "the local gateway",
    async () => (await fetch("http://127.0.0.1:7433/healthz")).ok,
  );
  const emails = await call(url, localToken, "SELECT email FROM customers");
  check(
    !emails.isError && !emails.text.includes("@example.com"),
    "emails come back masked",
  );
  const held = await call(
    url,
    localToken,
    "UPDATE support_tickets SET status = 'closed' WHERE id = 2",
  );
  check(
    held.isError && /approvals are unavailable/.test(held.text),
    "a held write says approvals are unavailable in local mode",
  );
  const ticket = await call(
    url,
    localToken,
    "SELECT body FROM support_tickets WHERE id = 1",
  );
  check(!ticket.isError, "an untrusted ticket can be read");
  const keys = await call(url, localToken, "SELECT secret FROM api_keys");
  check(
    keys.isError && /labeled secret/.test(keys.text),
    "after it, the secret table is closed",
  );
} finally {
  await stop(local);
}
checkStopped(local, "midplane local");
const exported = join(qs, "audit.jsonl");
midplane(["audit", "export", "--config", "midplane.yaml", "--out", exported], {
  cwd: qs,
});
check(
  /audit chain verified/.test(
    midplane(["audit", "verify", "--file", exported]),
  ),
  "the audit export verifies",
);

// ── 2. linked mode against the stand-in cloud ─────────────────────────────

step("linked mode: enroll, gateway, a bundle, a query and its audit push");
const cloud = await startFakeCloud();
const linked = join(work, "linked");
mkdirSync(linked);
const port = 7434;
writeFileSync(
  join(linked, "midplane.yaml"),
  JSON.stringify({
    listen: { host: "127.0.0.1", port },
    audit: { file: "audit.db" },
    mask_salt: { env: "MIDPLANE_MASK_SALT" },
    link: {
      cloud_url: cloud.url,
      identity: { file: "identity.json" },
      enrollment_token: { env: "ENROLL" },
      name: "smoke",
    },
    databases: { shop: { dsn: { env: "SHOP_DSN" } } },
  }),
);
const linkedEnv = { ...env, ENROLL: cloud.enrollmentToken() };
// `midplane enroll` prints an identity for a secret manager...
const identity = JSON.parse(
  await midplaneAsync(["enroll", "--config", "midplane.yaml"], {
    cwd: linked,
    env: linkedEnv,
  }),
) as { gateway_id?: string };
check(identity.gateway_id, "midplane enroll prints an identity");
// ...and `midplane gateway` enrolls on its own, with a fresh token, when
// its identity is a file it hasn't written yet.
const policy = (
  parseYaml(readFileSync(join(QUICKSTART, "midplane.yaml"), "utf8")) as {
    databases: { shop: { policy: unknown } };
  }
).databases.shop.policy;
const gateway = spawn(bin, ["gateway", "--config", "midplane.yaml"], {
  cwd: linked,
  env: { ...process.env, ...linkedEnv, ENROLL: cloud.enrollmentToken() },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  // The gateway's own enrollment, not the one `midplane enroll` made.
  await waitFor(
    "enrollment",
    () => cloud.gatewayId !== null && cloud.gatewayId !== identity.gateway_id,
  );
  const { version: bundle } = await cloud.publish({ shop: policy });
  await waitFor("the bundle", () =>
    cloud.statuses.some(
      (s) => s.bundle_version === bundle && s.state === "enforcing",
    ),
  ).catch((err) => {
    process.stdout.write(
      `  last status: ${JSON.stringify(cloud.statuses.at(-1))}\n`,
    );
    throw err;
  });
  check(true, `the gateway enforces bundle v${bundle}`);
  const url = `http://127.0.0.1:${port}/mcp`;
  const agent = await cloud.agentToken({
    audience: url,
    databases: { shop: "read" },
  });
  const r = await call(url, agent, "SELECT name FROM customers WHERE id = 1");
  check(!r.isError && r.text.includes("Dana Ng"), "a linked query runs");
  await waitFor("the audit push", () =>
    [...cloud.audit.values()].some((m) =>
      [...m.values()].some(
        (rec) =>
          rec.event === "ATTEMPTED" &&
          rec.statement === "SELECT name FROM customers WHERE id = $1",
      ),
    ),
  );
  check(true, "its audit record reached the cloud, redacted");
} finally {
  await stop(gateway);
  await cloud.close();
}
checkStopped(gateway, "midplane gateway");

step("midplane setup: test the connection string, write, enroll and serve");
const setupCloud = await startFakeCloud();
const setupDir = join(work, "setup");
const setupPort = 7435;
const setup = spawn(
  bin,
  [
    "setup",
    "--cloud",
    setupCloud.url,
    "--token",
    setupCloud.enrollmentToken(),
    "--database",
    "shop",
    "--dir",
    setupDir,
    "--port",
    String(setupPort),
  ],
  { cwd: work, stdio: ["pipe", "pipe", "inherit"] },
);
let said = "";
setup.stdout?.on("data", (d) => {
  said += String(d);
});
// The connection string for `shop`, then no other database.
setup.stdin?.end(`${SHOP_DSN}\n\n`);
try {
  await waitFor("setup's enrollment", () => setupCloud.gatewayId !== null);
  check(
    /ok: database shop on 127\.0\.0\.1, \d+ tables/.test(said),
    "setup tests the connection string",
  );
  check(!said.includes(SHOP_DSN), "and never prints it");
  check(
    (statSync(join(setupDir, "secrets")).mode & 0o777) === 0o700 &&
      (statSync(join(setupDir, "secrets", "shop.dsn")).mode & 0o777) === 0o600,
    "it keeps the connection string in a file only this user reads",
  );
  const { version: bundle } = await setupCloud.publish({ shop: policy });
  await waitFor("the bundle", () =>
    setupCloud.statuses.some(
      (s) => s.bundle_version === bundle && s.state === "enforcing",
    ),
  );
  const agent = await setupCloud.agentToken({
    audience: setupCloud.registered[0] as string,
    databases: { shop: "read" },
  });
  const r = await call(
    `http://127.0.0.1:${setupPort}/mcp`,
    agent,
    "SELECT name FROM customers WHERE id = 1",
  );
  check(
    !r.isError && r.text.includes("Dana Ng"),
    "the gateway it started serves a query",
  );
} finally {
  await stop(setup);
  await setupCloud.close();
}
checkStopped(setup, "the gateway midplane setup started");

// ── 3. the image ──────────────────────────────────────────────────────────

if (values.image) {
  const image = values.image;
  step(`the image ${image}`);
  const docker = (args: string[]) =>
    execFileSync("docker", args, {
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60_000,
    })
      .toString()
      .trim();
  check(
    docker(["run", "--rm", image, "--version"]) === `midplane ${version}`,
    "the image runs midplane --version",
  );
  check(
    docker(["run", "--rm", "--entrypoint", "id", image, "-u"]) !== "0",
    "it runs as a non-root user",
  );
  // The quickstart's config, with its audit file in the image's working
  // directory, which the non-root user owns.
  const conf = join(work, "docker");
  mkdirSync(conf);
  cpSync(
    join(qs, "midplane-verify-key.json"),
    join(conf, "midplane-verify-key.json"),
  );
  const doc = parseYaml(readFileSync(join(qs, "midplane.yaml"), "utf8")) as {
    audit: { file: string };
  };
  doc.audit.file = "/var/lib/midplane/midplane-audit.db";
  writeFileSync(join(conf, "midplane.yaml"), JSON.stringify(doc));
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "quickstart_default",
      "-v",
      `${conf}:/etc/midplane:ro`,
      "-e",
      `SHOP_DSN=${SHOP_DSN_IN_DOCKER}`,
      "-e",
      `MIDPLANE_MASK_SALT=${salt}`,
      "-e",
      `MIDPLANE_TOKEN=${localToken}`,
      image,
      "local",
      "--config",
      "/etc/midplane/midplane.yaml",
      "--stdio",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = createInterface({
    input: child.stdout as NonNullable<typeof child.stdout>,
  });
  const replies: unknown[] = [];
  const waiting: ((v: unknown) => void)[] = [];
  lines.on("line", (l) => {
    const msg = JSON.parse(l);
    const w = waiting.shift();
    if (w) w(msg);
    else replies.push(msg);
  });
  const next = () =>
    new Promise<unknown>((r) => {
      const m = replies.shift();
      if (m) r(m);
      else waiting.push(r);
    });
  const send = (m: unknown) => child.stdin?.write(`${JSON.stringify(m)}\n`);
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    });
    const init = (await next()) as {
      result?: { serverInfo?: { name?: string } };
    };
    check(
      init.result?.serverInfo?.name === "midplane",
      "the image speaks MCP over stdio",
    );
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "query",
        arguments: { sql: "SELECT email FROM customers" },
      },
    });
    const reply = JSON.stringify(await next());
    check(
      reply.includes('"rows"') && !reply.includes("@example.com"),
      "and masks the quickstart's emails",
    );
  } finally {
    child.kill("SIGTERM");
  }

  // Setup in the image, as the dashboard's server commands run it: the
  // config, the identity and every secret on a volume, and nothing on the
  // host but the TLS folder. The stand-in cloud is http, which a gateway
  // takes only on loopback, so both containers share this machine's
  // network: Docker's host networking, Linux only.
  if (process.platform !== "linux") {
    process.stdout.write(
      "  - setup in the image needs Docker's host networking (Linux); skipped\n",
    );
  } else {
    step(
      "setup and gateway in the image: secrets on a volume, served over TLS",
    );
    const tls = join(work, "tls");
    mkdirSync(tls);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(tls, "tls.key"),
        "-out",
        join(tls, "tls.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    // The image's user (uid 1000) reads the folder.
    chmodSync(join(tls, "tls.key"), 0o644);
    const volume = `midplane-smoke-${randomBytes(4).toString("hex")}`;
    docker(["volume", "create", volume]);
    const mounts = [
      "-v",
      `${volume}:/var/lib/midplane`,
      "-v",
      `${tls}:/etc/midplane/tls:ro`,
    ];
    const imageCloud = await startFakeCloud();
    const tlsPort = 7436;
    let container = "";
    try {
      // Answered on stdin, without blocking: the stand-in cloud answers
      // from this process.
      const said = await new Promise<string>((done, fail) => {
        const run = spawn(
          "docker",
          [
            "run",
            "-i",
            "--rm",
            "--network",
            "host",
            ...mounts,
            image,
            "setup",
            "--no-start",
            "--dir",
            "/var/lib/midplane",
            "--cloud",
            imageCloud.url,
            "--token",
            imageCloud.enrollmentToken(),
            "--url",
            `https://localhost:${tlsPort}`,
            "--port",
            String(tlsPort),
            "--database",
            "shop",
          ],
          { stdio: ["pipe", "pipe", "inherit"] },
        );
        let out = "";
        run.stdout?.on("data", (d) => {
          out += String(d);
        });
        run.stdin?.end(`${SHOP_DSN}\n\n`);
        run.on("exit", (code) =>
          code === 0
            ? done(out)
            : fail(new Error(`setup in the image: exit ${code}\n${out}`)),
        );
      });
      check(
        imageCloud.gatewayId !== null && said.includes("Enrolled gateway"),
        "setup in the image enrolls",
      );
      container = docker([
        "run",
        "-d",
        "--network",
        "host",
        ...mounts,
        image,
        "gateway",
        "--config",
        "/var/lib/midplane/midplane.yaml",
      ]);
      const { version: bundle } = await imageCloud.publish({ shop: policy });
      await waitFor(
        "the image's gateway to enforce",
        () =>
          imageCloud.statuses.some(
            (s) => s.bundle_version === bundle && s.state === "enforcing",
          ),
        60_000,
      );
      const agent = await imageCloud.agentToken({
        audience: `https://localhost:${tlsPort}/mcp`,
        databases: { shop: "read" },
      });
      const r = await call(
        `https://localhost:${tlsPort}/mcp`,
        agent,
        "SELECT name FROM customers WHERE id = 1",
        readFileSync(join(tls, "tls.crt"), "utf8"),
      );
      check(
        !r.isError && r.text.includes("Dana Ng"),
        "the gateway serves a query over TLS",
      );
      const kept = docker([
        "run",
        "--rm",
        "-v",
        `${volume}:/var/lib/midplane`,
        "--entrypoint",
        "ls",
        image,
        "-A",
        "/var/lib/midplane",
      ]).split("\n");
      check(
        ["midplane.yaml", "identity.json", "secrets"].every((f) =>
          kept.includes(f),
        ) && readdirSync(tls).sort().join(" ") === "tls.crt tls.key",
        "the volume holds the config, the identity and the secrets; the host only the TLS folder",
      );
    } catch (err) {
      if (container) {
        execFileSync("docker", ["logs", container], { stdio: "inherit" });
      }
      throw err;
    } finally {
      if (container) docker(["rm", "-f", container]);
      docker(["volume", "rm", "-f", volume]);
      await imageCloud.close();
    }
  }
}

process.stdout.write("\nsmoke test passed\n");
process.exit(0);
