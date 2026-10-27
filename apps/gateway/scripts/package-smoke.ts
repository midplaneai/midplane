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
//      quickstart's Docker network, as its non-root user, and its default
//      command with nothing to start from, and with a config mounted; and
//      on Linux, `setup` and `gateway` in the image with every secret on a
//      volume and nothing on the host but the TLS folder, served over TLS;
//      then `setup --acme` against Pebble (Let's Encrypt's test CA), whose
//      certificate the gateway then serves MCP with, nothing on the host;
//      then one detached `docker run --env-file`, the default command,
//      which sets itself up from the environment, enrolls, gets its
//      certificate from Pebble as it starts and serves, and restarted
//      serves again without enrolling or ordering, no connection string on
//      the volume, in its logs or sent.
//
// Needs the quickstart's database: `docker compose -f
// examples/quickstart/compose.yaml up -d --wait` (from oss/).
//
//   node apps/gateway/scripts/package-smoke.ts [--tarball <file>] [--image <tag>]

import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
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
// Let's Encrypt's test CA and the DNS server it resolves names with, 2.10.1,
// pinned by digest.
const PEBBLE =
  "ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199";
const PEBBLE_CHALLTESTSRV =
  "ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b";

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

/**
 * Over https, trusting only `ca`, and connecting to `address` when given:
 * a name only Pebble's DNS knows is still checked against the certificate.
 */
interface Tls {
  ca: string;
  address?: string;
}

/** How long one https request may take before it fails. */
const REQUEST_MS = 10_000;

/** An https request's status and body; it fails rather than hangs. */
function httpsText(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string },
  tls: Tls,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((done, fail) => {
    const req = httpsRequest(
      {
        host: tls.address ?? target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: o.method ?? "GET",
        servername: target.hostname,
        // ACME servers refuse a request without one (RFC 8555, 6.1).
        headers: {
          "user-agent": "midplane-package-smoke",
          ...o.headers,
          host: target.host,
        },
        ca: tls.ca,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          raw += d;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, body: raw }));
        res.on("error", fail);
        res.on("aborted", () =>
          fail(new Error(`${url}: the answer was cut off`)),
        );
      },
    );
    req.setTimeout(REQUEST_MS, () =>
      req.destroy(new Error(`${url}: no answer in ${REQUEST_MS / 1000} s`)),
    );
    req.on("error", fail);
    req.end(o.body);
  });
}

/** A POST's answer, over https as `tls` says when given. */
async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  tls?: Tls,
): Promise<string> {
  if (!tls) return (await fetch(url, { method: "POST", headers, body })).text();
  return (await httpsText(url, { method: "POST", headers, body }, tls)).body;
}

/** One MCP tools/call over HTTP, the 2025 handshake. */
async function call(
  url: string,
  token: string,
  sql: string,
  tls?: Tls,
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
    tls,
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
  /** The default command's exit status and its last log line. */
  const startInImage = (args: string[]) => {
    const r = spawnSync("docker", ["run", "--rm", ...args, image], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const last = r.stderr.trim().split("\n").at(-1) ?? "";
    try {
      return {
        status: r.status,
        msg: (JSON.parse(last) as { msg?: string }).msg,
      };
    } catch {
      return { status: r.status, msg: last };
    }
  };
  // protects=the image's default command says how to give it something to start from, and exits 1, when it has nothing;
  // fails_when=it exits 0, serves nothing silently, or the sentence isn't its last line;
  // no_claim=nothing about setup (the env file step below, on Linux)
  const none = startInImage([]);
  check(
    none.status === 1 &&
      none.msg ===
        "no config: mount one at /etc/midplane/midplane.yaml, or set MIDPLANE_ENROLLMENT_TOKEN from your project's setup page",
    "with nothing to start from, the default command exits 1 saying how to give it a config",
  );
  // protects=a config mounted at /etc/midplane/midplane.yaml is what the default command loads, even with a token in the environment;
  // fails_when=the token sets the gateway up instead, or the mounted config is ignored;
  // no_claim=serving it (the same startLinked as `gateway --config`; this config stops at its missing variable)
  const mounted = join(work, "mounted");
  mkdirSync(mounted);
  writeFileSync(
    join(mounted, "midplane.yaml"),
    JSON.stringify({
      audit: { file: "/var/lib/midplane/audit.db" },
      link: {
        cloud_url: "https://eu.app.midplane.ai",
        identity: { file: "/var/lib/midplane/identity.json" },
      },
      databases: { shop: { dsn: { env: "SHOP_DSN" } } },
    }),
  );
  const fromMount = startInImage([
    "-v",
    `${mounted}:/etc/midplane:ro`,
    "-e",
    `MIDPLANE_ENROLLMENT_TOKEN=mpe1_${"A".repeat(86)}`,
  ]);
  check(
    fromMount.status === 1 &&
      fromMount.msg ===
        "databases.shop.dsn: environment variable SHOP_DSN is not set",
    "with a config mounted, the default command loads it, not the token",
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

  /**
   * `setup --no-start` in the image on this machine's network, serving
   * `shop`, answered on stdin without blocking: the stand-in cloud answers
   * from this process. What it printed.
   */
  const setupInImage = (docker: string[], flags: string[]) =>
    new Promise<string>((done, fail) => {
      const run = spawn(
        "docker",
        [
          "run",
          "-i",
          "--rm",
          "--network",
          "host",
          ...docker,
          image,
          "setup",
          "--no-start",
          "--dir",
          "/var/lib/midplane",
          ...flags,
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
      const said = await setupInImage(mounts, [
        "--cloud",
        imageCloud.url,
        "--token",
        imageCloud.enrollmentToken(),
        "--url",
        `https://localhost:${tlsPort}`,
        "--port",
        String(tlsPort),
      ]);
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
        { ca: readFileSync(join(tls, "tls.crt"), "utf8") },
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

    // As the dashboard's Automatic certificate runs it, against Pebble, the
    // test CA Let's Encrypt publishes: setup in the image gets the
    // certificate (answering Pebble's challenge on 7480, which -p 80:7480
    // stands for on a server), then the gateway serves MCP with it. Pebble
    // finds every name at this machine through challtestsrv's DNS, and the
    // gateway trusts Pebble's API through NODE_EXTRA_CA_CERTS.
    step("setup --acme in the image against Pebble, then MCP over HTTPS");
    const acmeHost = "gateway.midplane.test";
    const acmePort = 7437;
    const pebbleDir = join(work, "pebble");
    const caDir = join(pebbleDir, "ca");
    mkdirSync(caDir, { recursive: true });
    writeFileSync(
      join(pebbleDir, "pebble-config.json"),
      JSON.stringify({
        pebble: {
          listenAddress: "127.0.0.1:14000",
          managementListenAddress: "127.0.0.1:15000",
          certificate: "/test/certs/localhost/cert.pem",
          privateKey: "/test/certs/localhost/key.pem",
          httpPort: 7480,
          tlsPort: 5001,
          ocspResponderURL: "",
          externalAccountBindingRequired: false,
        },
      }),
    );
    const acmeVolume = `midplane-smoke-acme-${randomBytes(4).toString("hex")}`;
    const acmeCloud = await startFakeCloud();
    const helpers: string[] = [];
    let acmeContainer = "";
    const startVolume = `midplane-smoke-start-${randomBytes(4).toString("hex")}`;
    let startCloud: Awaited<ReturnType<typeof startFakeCloud>> | null = null;
    let startContainer = "";
    try {
      helpers.push(
        docker([
          "run",
          "-d",
          "--network",
          "host",
          PEBBLE_CHALLTESTSRV,
          "-defaultIPv4",
          "127.0.0.1",
          "-defaultIPv6",
          "",
          "-http01",
          "",
          "-https01",
          "",
          "-tlsalpn01",
          "",
          "-doh",
          "",
        ]),
      );
      const pebble = docker([
        "run",
        "-d",
        "--network",
        "host",
        "-e",
        "PEBBLE_VA_NOSLEEP=1",
        "-e",
        "PEBBLE_WFE_NONCEREJECT=0",
        "-v",
        `${join(pebbleDir, "pebble-config.json")}:/smoke/pebble-config.json:ro`,
        PEBBLE,
        "-config",
        "/smoke/pebble-config.json",
        "-dnsserver",
        "127.0.0.1:8053",
      ]);
      helpers.push(pebble);
      docker([
        "cp",
        `${pebble}:/test/certs/pebble.minica.pem`,
        join(caDir, "minica.pem"),
      ]);
      chmodSync(join(caDir, "minica.pem"), 0o644);
      const minica = readFileSync(join(caDir, "minica.pem"), "utf8");
      // What Pebble last answered, so a refusal reads as itself, not a timeout.
      let lastPebble = "nothing yet";
      await waitFor("Pebble", async () => {
        try {
          const r = await httpsText(
            "https://localhost:14000/dir",
            {},
            { ca: minica },
          );
          lastPebble = `${r.status} ${r.body.slice(0, 200)}`;
          return r.status === 200;
        } catch (err) {
          lastPebble = String(err);
          throw err;
        }
      }).catch((err) => {
        throw new Error(
          `${(err as Error).message}; Pebble last said: ${lastPebble}`,
        );
      });
      const trust = [
        "-v",
        `${caDir}:/etc/pebble:ro`,
        "-e",
        "NODE_EXTRA_CA_CERTS=/etc/pebble/minica.pem",
      ];
      const data = ["-v", `${acmeVolume}:/var/lib/midplane`];
      const said = await setupInImage(
        [...data, ...trust],
        [
          "--cloud",
          acmeCloud.url,
          "--token",
          acmeCloud.enrollmentToken(),
          "--url",
          `https://${acmeHost}:${acmePort}`,
          "--acme",
          "--acme-directory",
          "https://localhost:14000/dir",
          "--port",
          String(acmePort),
        ],
      );
      check(
        /Getting a certificate for gateway\.midplane\.test from the ACME server at localhost:14000…\n {2}ok: valid until /.test(
          said,
        ) && acmeCloud.gatewayId !== null,
        "setup --acme in the image gets a certificate from Pebble, then enrolls",
      );
      check(
        said.includes(
          "Start the gateway with the second command on the setup page.",
        ),
        "and says to start the gateway with the dashboard's second command",
      );
      acmeContainer = docker([
        "run",
        "-d",
        "--network",
        "host",
        ...data,
        ...trust,
        image,
        "gateway",
        "--config",
        "/var/lib/midplane/midplane.yaml",
      ]);
      const { version: bundle } = await acmeCloud.publish({ shop: policy });
      await waitFor(
        "the ACME gateway to enforce",
        () =>
          acmeCloud.statuses.some(
            (s) => s.bundle_version === bundle && s.state === "enforcing",
          ),
        60_000,
      );
      // Pebble's root for this run: what an agent would trust for Let's Encrypt.
      const root = (
        await httpsText("https://localhost:15000/roots/0", {}, { ca: minica })
      ).body;
      const agent = await acmeCloud.agentToken({
        audience: `https://${acmeHost}:${acmePort}/mcp`,
        databases: { shop: "read" },
      });
      const r = await call(
        `https://${acmeHost}:${acmePort}/mcp`,
        agent,
        "SELECT name FROM customers WHERE id = 1",
        { ca: root, address: "127.0.0.1" },
      );
      check(
        !r.isError && r.text.includes("Dana Ng"),
        "the gateway serves a query over HTTPS with the certificate Pebble issued",
      );
      const acmeFiles = docker([
        "run",
        "--rm",
        ...data,
        "--entrypoint",
        "ls",
        image,
        "-A",
        "/var/lib/midplane/acme",
      ]).split("\n");
      check(
        ["account.key", "cert.pem", "key.pem"].every((f) =>
          acmeFiles.includes(f),
        ) && readdirSync(caDir).join(" ") === "minica.pem",
        "the certificate and its key live on the volume; the host holds none",
      );
      // Its challenge listener holds 7480, which the next gateway needs.
      docker(["rm", "-f", acmeContainer]);
      acmeContainer = "";

      // protects=one detached `docker run --env-file` with the default command enrolls, then gets its certificate from Pebble as it starts, and serves a query; restarted, it serves again with no enrollment and no new certificate; no connection string on the volume, in its logs or in anything sent to the cloud;
      // fails_when=it needs a terminal or a second command, enrolls or orders again on restart, or a connection string reaches the volume, `docker logs` or the cloud;
      // no_claim=Let's Encrypt itself, or a platform's secret store (only Docker's env file)
      step(
        "one docker run with an env file: set up from the environment, a certificate from Pebble, a query; then a restart",
      );
      const startHost = "start.midplane.test";
      const startPort = 7438;
      const startUrl = `https://${startHost}:${startPort}`;
      startCloud = await startFakeCloud();
      const envFile = join(work, "start.env");
      writeFileSync(
        envFile,
        [
          `MIDPLANE_CLOUD_URL=${startCloud.url}`,
          `MIDPLANE_ENROLLMENT_TOKEN=${startCloud.enrollmentToken()}`,
          `MIDPLANE_URL=${startUrl}`,
          `MIDPLANE_PORT=${startPort}`,
          "MIDPLANE_ACME_DIRECTORY=https://localhost:14000/dir",
          `MIDPLANE_DSN_SHOP=${SHOP_DSN}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      startContainer = docker([
        "run",
        "-d",
        "--network",
        "host",
        "--env-file",
        envFile,
        "-v",
        `${startVolume}:/var/lib/midplane`,
        ...trust,
        image,
      ]);
      const enrolled = () =>
        startCloud?.bodies.filter((b) => b.path === "/link/v1/enroll").length;
      await waitFor(
        "the container's enrollment",
        () => startCloud?.gatewayId != null,
        60_000,
      );
      const { version: startBundle } = await startCloud.publish({
        shop: policy,
      });
      const enforcing = () =>
        startCloud?.statuses.some(
          (s) => s.bundle_version === startBundle && s.state === "enforcing",
        ) === true;
      await waitFor("the container's gateway to enforce", enforcing, 60_000);
      const startAgent = await startCloud.agentToken({
        audience: `${startUrl}/mcp`,
        databases: { shop: "read" },
      });
      const query = () =>
        call(
          `${startUrl}/mcp`,
          startAgent,
          "SELECT name FROM customers WHERE id = 1",
          { ca: root, address: "127.0.0.1" },
        );
      const first = await query();
      check(
        !first.isError && first.text.includes("Dana Ng"),
        "it enrolls, gets a certificate from Pebble and serves a query",
      );
      const certHash = () =>
        docker([
          "run",
          "--rm",
          "-v",
          `${startVolume}:/var/lib/midplane`,
          "--entrypoint",
          "sha256sum",
          image,
          "/var/lib/midplane/acme/cert.pem",
        ]);
      const cert = certHash();

      docker(["restart", startContainer]);
      await waitFor(
        "the restarted gateway to serve",
        async () => {
          const r = await query();
          return !r.isError && r.text.includes("Dana Ng");
        },
        60_000,
      );
      const logs = spawnSync("docker", ["logs", startContainer], {
        encoding: "utf8",
      });
      const logged = `${logs.stdout}${logs.stderr}`;
      const count = (text: string) => logged.split(text).length - 1;
      check(
        enrolled() === 1 &&
          count("certificate obtained") === 1 &&
          count("starting from the config") === 1 &&
          certHash() === cert,
        "restarted, it serves again without enrolling or a new certificate",
      );
      // The volume, every file in one tar stream, as the image's user reads it.
      const volumeBytes = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${startVolume}:/var/lib/midplane`,
          "--entrypoint",
          "tar",
          image,
          "-C",
          "/var/lib/midplane",
          "-cf",
          "-",
          ".",
        ],
        { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
      ).toString("latin1");
      const leaks = [SHOP_DSN, "midplane_agent:quickstart@"];
      const places = [
        { where: "the volume", text: volumeBytes },
        { where: "docker logs", text: logged },
        ...startCloud.bodies.map((b) => ({ where: b.path, text: b.body })),
      ];
      const leaked = places.filter((p) =>
        leaks.some((l) => p.text.includes(l)),
      );
      check(
        volumeBytes.includes("MIDPLANE_DSN_SHOP") && leaked.length === 0,
        `no connection string on the volume, in its logs or sent to the cloud${leaked.length > 0 ? ` (found in ${leaked.map((p) => p.where).join(", ")})` : ""}`,
      );
    } catch (err) {
      for (const c of [acmeContainer, startContainer, ...helpers].filter(
        Boolean,
      )) {
        execFileSync("docker", ["logs", c], { stdio: "inherit" });
      }
      throw err;
    } finally {
      for (const c of [acmeContainer, startContainer, ...helpers].filter(
        Boolean,
      )) {
        docker(["rm", "-f", c]);
      }
      docker(["volume", "rm", "-f", acmeVolume]);
      docker(["volume", "rm", "-f", startVolume]);
      await acmeCloud.close();
      await startCloud?.close();
    }
  }
}

process.stdout.write("\nsmoke test passed\n");
process.exit(0);
