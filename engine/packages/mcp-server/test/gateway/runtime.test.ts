// The gateway runtime end to end against a fake control plane: enrollment, the
// pull loop, the three states, the on-disk cache, heartbeats and the signed
// approval gate. No Postgres — the engine gets a mock executor — but every
// link request is real HTTP and every token is verified by the fake cloud with
// the same protocol module the real control plane uses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { buildEngine, type BuiltEngineHandle } from "../../src/engine-factory.ts";
import { ensureIdentity } from "../../src/gateway/enroll.ts";
import { LinkClient } from "../../src/gateway/link-client.ts";
import { EnrollmentError } from "../../src/gateway/protocol.ts";
import { GatewayRuntime, createGatewayApprovalGate } from "../../src/gateway/runtime.ts";
import { GatewayStateDir } from "../../src/gateway/state.ts";
import { buildServer } from "../../src/server.ts";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { MockExecutor } from "../_helpers.ts";
import { FakeCloud } from "./_fake-cloud.ts";
import { testKey } from "./_fixtures.ts";

const MAIN_ENV = "MIDPLANE_DSN_01MAINAAAAAAAAAAAAAAAAAAAA";
const ANALYTICS_ENV = "MIDPLANE_DSN_01ANALYTICSAAAAAAAAAAAAAAA";
const MAIN_DSN = "postgres://gateway:hunter2@db.internal:5432/app";
const WRITE = "UPDATE orders SET status = 'x' WHERE id = 1";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function policy(o: { approvals?: boolean; analytics?: boolean; requires?: string[] } = {}): string {
  const db = (name: string, env: string, extra: string[] = []) => [
    `  - name: ${name}`,
    `    url: \${${env}}`,
    "    table_access:",
    "      default: read_write",
    "      tables: {}",
    "    guardrails:",
    "      block_unqualified_dml: true",
    "      block_ddl: true",
    ...extra,
  ];
  const features = [...(o.approvals ? ["write_approvals"] : []), ...(o.requires ?? [])];
  const mainExtra = [
    ...(features.length ? ["    requires_features:", ...features.map((f) => `      - ${f}`)] : []),
    ...(o.approvals ? ["    approvals:", "      writes: true"] : []),
  ];
  return [
    "databases:",
    ...db("main", MAIN_ENV, mainExtra),
    ...(o.analytics ? db("analytics", ANALYTICS_ENV) : []),
  ].join("\n") + "\n";
}

interface Gateway {
  runtime: GatewayRuntime;
  handle: BuiltEngineHandle;
  state: GatewayStateDir;
  gatewayId: string;
  executor: MockExecutor;
}

describe("gateway runtime", () => {
  let cloud: FakeCloud;
  let dir: string;
  let stateDir: string;
  let token: string;
  const open: Array<{ handle: BuiltEngineHandle; runtime: GatewayRuntime }> = [];
  const servers: HttpHandle[] = [];

  beforeEach(async () => {
    cloud = await FakeCloud.start();
    dir = mkdtempSync(join(tmpdir(), "midplane-gw-"));
    stateDir = join(dir, "state");
    token = cloud.mintToken();
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const g of open.splice(0)) {
      g.runtime.stop();
      await g.handle.close();
    }
    await cloud.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  /** What `midplane gateway` does at boot, minus the process and the listener. */
  async function boot(opts: { cloudUrl?: string; env?: NodeJS.ProcessEnv; enrollToken?: string | null } = {}): Promise<Gateway> {
    const cloudUrl = opts.cloudUrl ?? cloud.origin;
    const state = GatewayStateDir.open(stateDir);
    const client = new LinkClient(cloudUrl, "midplane-gateway/test");
    const enrolled = await ensureIdentity(
      state,
      client,
      { cloudUrl, enrollToken: opts.enrollToken === undefined ? token : opts.enrollToken, name: "test", engineVersion: "0.0.0-test", capabilities: {} },
      quiet,
    );
    const approvalGate = createGatewayApprovalGate({
      cloudUrl,
      client,
      identity: enrolled.identity,
      privateKey: enrolled.privateKey,
    });
    const executor = new MockExecutor();
    const handle = buildEngine(
      {
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, `audit-${open.length}.db`),
        tenantId: "__self_host__",
        transport: "http",
        maskSalt: "s".repeat(32),
        maskSourceRewrite: false,
      },
      { startEmpty: true, executor, approvalGate },
    );
    const runtime = new GatewayRuntime({
      identity: enrolled.identity,
      privateKey: enrolled.privateKey,
      state,
      client,
      handle,
      env: opts.env ?? { [MAIN_ENV]: MAIN_DSN },
      pollSeconds: 15,
      engineVersion: "0.0.0-test",
      runtimeLabel: "bun test",
      installShape: "source",
      tenantId: "__self_host__",
      log: quiet,
    });
    open.push({ handle, runtime });
    await runtime.bootFromCache();
    return { runtime, handle, state, gatewayId: enrolled.identity.gateway_id, executor };
  }

  function queryTool(gw: Gateway) {
    const server = buildServer({ handle: gw.handle, approvalGate: gw.handle.approvalGate, serving: gw.runtime.servingGuard() });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })
      ._registeredTools;
    return async (sql: string) =>
      (await tools.query!.handler({ sql, intent: "test" })) as { isError?: boolean; content: Array<{ text: string }> };
  }

  async function closedOrigin(): Promise<string> {
    // Stop the cloud and reuse its now-closed origin: "unreachable", not "wrong URL".
    await cloud.stop();
    return cloud.origin;
  }

  // ── enrollment ──────────────────────────────────────────────────────────

  describe("enrollment", () => {
    test("first boot enrolls: key 0600, identity pinned to the cloud's key and version floor", async () => {
      cloud.publish(policy());
      cloud.publish(policy());
      const gw = await boot();
      const identity = JSON.parse(readFileSync(join(stateDir, "identity.json"), "utf8"));
      expect(identity.gateway_id).toBe(gw.gatewayId);
      expect(identity.project_id).toBe(cloud.projectId);
      expect(identity.signing_key.kid).toBe(cloud.bundleKey.kid);
      expect(identity.min_version).toBe(2);
      expect(statSync(join(stateDir, "gateway.key")).mode & 0o777).toBe(0o600);
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    });

    test("an existing identity wins; the (spent) token is ignored", async () => {
      cloud.publish(policy());
      const first = await boot();
      const again = await ensureIdentity(
        GatewayStateDir.open(stateDir),
        new LinkClient(cloud.origin, "t"),
        { cloudUrl: cloud.origin, enrollToken: "mpe1_garbage", name: "t", engineVersion: "0", capabilities: {} },
        quiet,
      );
      expect(again.enrolledNow).toBe(false);
      expect(again.identity.gateway_id).toBe(first.gatewayId);
    });

    test("a response not signed by the pinned key is refused and nothing is written", async () => {
      cloud.publish(policy());
      const mitmToken = cloud.mintToken(testKey().raw); // pin of a key the cloud doesn't sign with
      await expect(boot({ enrollToken: mitmToken })).rejects.toThrow(/not signed by the key pinned/);
      expect(existsSync(join(stateDir, "identity.json"))).toBe(false);
    });

    test("a lost response is recovered: the retry presents the same key and gets the same gateway", async () => {
      cloud.publish(policy());
      const state = GatewayStateDir.open(stateDir);
      const key = state.loadOrCreateKey();
      // The first attempt reached the cloud (token consumed) but the answer never arrived.
      await new LinkClient(cloud.origin, "t").enroll({ token, name: "t" }, key);
      const gw = await boot();
      expect(cloud.gateways.size).toBe(1);
      expect(cloud.gateways.has(gw.gatewayId)).toBe(true);
    });

    test("no identity and no token: a clear refusal to start", async () => {
      await expect(boot({ enrollToken: null })).rejects.toThrow(EnrollmentError);
    });
  });

  // ── never received / serving / restart ─────────────────────────────────

  test("never received a bundle: every tool is refused, /ready is 503, no database pool exists", async () => {
    cloud.publish(policy());
    const gw = await boot();
    const origin = await closedOrigin();
    expect(origin).toBe(cloud.origin);

    expect(await gw.runtime.pollOnce()).toBe("error");
    expect(gw.runtime.state).toBe("awaiting_bundle");
    expect(gw.runtime.ready().status).toBe(503);
    // Liveness stays up: a restart can't change "no policy yet".
    expect(gw.runtime.health()).toMatchObject({ status: 200, body: { state: "awaiting_bundle" } });
    expect(gw.handle.registry.count()).toBe(0);

    // Through a real MCP session over the gateway's transport.
    const http = await startHttp(
      (ctx) => buildServer({ handle: gw.handle, sessionContext: ctx, serving: gw.runtime.servingGuard() }),
      { port: 0, host: "127.0.0.1", health: () => gw.runtime.health(), ready: () => gw.runtime.ready(), identityHeaders: false },
    );
    servers.push(http);
    expect((await fetch(`http://127.0.0.1:${http.port}/ready`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${http.port}/health`)).status).toBe(200);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const res = (await client.callTool({ name: "query", arguments: { sql: "SELECT 1", intent: "probe" } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    await client.close();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ allowed: false, policy_rule: "gateway_state" });
    expect(gw.executor.calls).toHaveLength(0);

    // The refusal is a decision with a record.
    const rows = gw.handle.registry.audit.readSince("0", 100).filter((r) => r.event_type === "DECIDED");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.payload)).toContain("gateway_state");
  });

  test("the first bundle turns the gateway on; the cache holds it", async () => {
    cloud.publish(policy());
    const gw = await boot();
    expect(await gw.runtime.pollOnce()).toBe("bundle");
    expect(gw.runtime.state).toBe("serving");
    expect(gw.runtime.ready()).toMatchObject({ status: 200, body: { state: "serving", bundle_version: 1 } });
    expect(readFileSync(join(stateDir, "bundle.jws"), "utf8")).toBe(cloud.published[0]!);
    expect(await gw.runtime.pollOnce()).toBe("not_modified");
  });

  test("switched-off approvals reach a warm gateway through the pull loop; the gate is signed", async () => {
    cloud.publish(policy({ approvals: true }));
    const gw = await boot();
    await gw.runtime.pollOnce();
    const query = queryTool(gw);

    await query(WRITE);
    // The held write went to the control plane over a request token the fake
    // cloud verified against this gateway's key, path and body.
    expect(cloud.approvalRequests).toHaveLength(1);
    expect(cloud.approvalRequests[0]).toMatchObject({ sql: WRITE, database: "main" });

    cloud.publish(policy());
    expect(await gw.runtime.pollOnce()).toBe("bundle");
    expect(gw.runtime.state).toBe("serving");
    const ranBefore = gw.executor.calls.length;
    const res = await query(WRITE);
    // Not held, and actually executed — not refused for some other reason.
    expect(res.isError).toBeFalsy();
    expect(gw.executor.calls.length).toBe(ranBefore + 1);
    expect(cloud.approvalRequests).toHaveLength(1);
  });

  test("last-known-good survives a restart with the cloud down", async () => {
    cloud.publish(policy());
    cloud.publish(policy());
    cloud.publish(policy({ approvals: true }));
    const first = await boot();
    await first.runtime.pollOnce();
    first.runtime.stop();
    await first.handle.close();
    open.splice(0);

    const origin = await closedOrigin();
    const second = await boot({ cloudUrl: origin });
    expect(second.runtime.state).toBe("serving");
    expect(second.runtime.heartbeat()).toMatchObject({ bundle: { version: 3 } });
    expect(second.handle.policySnapshot()[0]!.approvals.row_changes).toBe(true);
    expect(await second.runtime.pollOnce()).toBe("error");
    expect(second.runtime.state).toBe("serving");
  });

  test("a tampered cache is not a policy: the gateway waits for the cloud instead", async () => {
    cloud.publish(policy());
    const first = await boot();
    await first.runtime.pollOnce();
    open.splice(0).forEach(({ runtime }) => runtime.stop());
    await first.handle.close();

    const jws = readFileSync(join(stateDir, "bundle.jws"), "utf8");
    const [h, p, s] = jws.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.policy = String(payload.policy).replace("read_write", "read");
    writeFileSync(join(stateDir, "bundle.jws"), `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`);

    const origin = await closedOrigin();
    const second = await boot({ cloudUrl: origin });
    expect(second.runtime.state).toBe("awaiting_bundle");
    expect(second.runtime.heartbeat().last_rejection).toMatchObject({ reason: "signature" });
  });

  // ── rejects keep enforcement ────────────────────────────────────────────

  test("forged, foreign and stale bundles are rejected and enforcement is unchanged", async () => {
    cloud.publish(policy());
    cloud.publish(policy({ approvals: true }));
    const gw = await boot();
    await gw.runtime.pollOnce();
    const before = gw.handle.policySnapshot();

    const attempts: Array<[string, string]> = [
      ["signature", cloud.sign(3, policy(), { key: { ...testKey(), kid: cloud.bundleKey.kid } })],
      ["unknown_kid", cloud.sign(3, policy(), { key: testKey() })],
      ["project", cloud.sign(3, policy(), { projectId: "01OTHERPROJECTAAAAAAAAAAAA" })],
      ["rollback", cloud.published[0]!],
      ["version_conflict", cloud.sign(2, policy())],
    ];
    for (const [reason, jws] of attempts) {
      cloud.override = jws;
      await gw.runtime.pollOnce();
      expect(gw.runtime.state).toBe("serving");
      expect(gw.runtime.heartbeat().last_rejection).toMatchObject({ reason });
      expect(gw.handle.policySnapshot()).toEqual(before);
    }
    // Rejected bundles never reach the cache.
    expect(readFileSync(join(stateDir, "bundle.jws"), "utf8")).toBe(cloud.published[1]!);
  });

  // ── halts ───────────────────────────────────────────────────────────────

  test("an authentic bundle this gateway can't enforce halts it; a restart with the cloud down stays halted", async () => {
    cloud.publish(policy());
    const gw = await boot();
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("serving");

    cloud.publish(policy({ requires: ["row_estimate_limits"] }));
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("halted");
    expect(gw.runtime.ready()).toMatchObject({ status: 503, body: { state: "halted" } });
    expect(gw.runtime.health().status).toBe(200);
    expect(String(gw.runtime.heartbeat().halt_reason)).toContain("row_estimate_limits");
    expect(gw.handle.registry.count()).toBe(0); // pools drained
    const refused = await queryTool(gw)("SELECT 1");
    expect(refused.isError).toBe(true);

    open.splice(0).forEach(({ runtime }) => runtime.stop());
    await gw.handle.close();
    const origin = await closedOrigin();
    const again = await boot({ cloudUrl: origin });
    // Not v1: the cache holds the newest authentic bundle, and v2 is still unenforceable.
    expect(again.runtime.state).toBe("halted");
  });

  test("an unknown field listed in crit halts; an unknown field not listed is ignored", async () => {
    cloud.publish(policy(), { extra: { display_label: "Q3" } });
    const gw = await boot();
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("serving");
    cloud.publish(policy(), { crit: ["max_staleness"], extra: { max_staleness: 3600 } });
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("halted");
  });

  test("pause is a signed kill switch; the next unpaused version serves again", async () => {
    cloud.publish(policy());
    const gw = await boot();
    await gw.runtime.pollOnce();
    cloud.publish(policy(), { paused: true });
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("halted");
    expect(JSON.parse((await queryTool(gw)("SELECT 1")).content[0]!.text).reason).toContain("paused");
    cloud.publish(policy());
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("serving");
  });

  // ── databases, heartbeat, revocation ────────────────────────────────────

  test("a bundle adding a database without its DSN variable still applies; that one database refuses", async () => {
    cloud.publish(policy({ analytics: true }));
    const gw = await boot();
    await gw.runtime.pollOnce();
    expect(gw.runtime.state).toBe("serving");
    const snap = gw.handle.policySnapshot();
    expect(snap.find((d) => d.name === "analytics")).toMatchObject({ status: "unconfigured", dsn_env: ANALYTICS_ENV });
    expect(snap.find((d) => d.name === "main")).toMatchObject({ status: "ready" });
  });

  test("the heartbeat is signed and reports what is enforced — never a DSN or the salt", async () => {
    const yaml = policy({ approvals: true });
    cloud.publish(yaml);
    const gw = await boot();
    await gw.runtime.pollOnce();
    expect(await gw.runtime.sendHeartbeat()).toBe(true);

    const hb = cloud.heartbeats.at(-1)!;
    expect(hb).toMatchObject({
      state: "serving",
      bundle: { version: 1, policy_sha256: createHash("sha256").update(yaml).digest("hex") },
      newest_version: 1,
      capabilities: { link: ["bundle.v1", "heartbeat.v1", "approval_gate.v1"] },
    });
    expect((hb.capabilities as { policy_features: string[] }).policy_features).toContain("write_approvals");
    expect((hb.databases as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "main",
      dsn_env: MAIN_ENV,
      approvals: { row_changes: true, whole_table_writes: true, schema_changes: true },
    });
    const wire = JSON.stringify(hb);
    expect(wire).not.toContain("hunter2");
    expect(wire).not.toContain("s".repeat(32));
  });

  test("a revoked gateway keeps enforcing its last policy", async () => {
    cloud.publish(policy());
    const gw = await boot();
    await gw.runtime.pollOnce();
    cloud.revoke(gw.gatewayId);
    cloud.publish(policy({ approvals: true }));
    expect(await gw.runtime.pollOnce()).toBe("error");
    expect(gw.runtime.state).toBe("serving");
    expect(gw.handle.policySnapshot()[0]!.approvals.row_changes).toBe(false);
  });
});

describe("gateway transport", () => {
  // One engine for every session the transport opens; closed after each test.
  let dir: string;
  let handle: BuiltEngineHandle;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-gw-transport-"));
    handle = buildEngine(
      { port: 0, host: "127.0.0.1", dbPath: join(dir, "a.db"), tenantId: "t", transport: "http", maskSourceRewrite: false },
      { startEmpty: true, executor: new MockExecutor() },
    );
  });
  afterEach(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(opts: { identityHeaders?: boolean; loopbackRequestsOnly?: boolean }, seen: unknown[] = []) {
    const http = await startHttp(
      (ctx) => {
        seen.push(ctx);
        return buildServer({ handle, sessionContext: ctx, serving: { check: () => ({ ok: false, reason: "test" }) } });
      },
      { port: 0, host: "127.0.0.1", ...opts },
    );
    servers.push(http);
    return http;
  }

  const servers: HttpHandle[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  // A syntactically valid ULID: a malformed one would be dropped by the header
  // parser anyway, and prove nothing about the flag.
  const TOKEN_ID = "01J8Z7FRGDTKNAAAAAAAAAAAAA";

  async function connect(url: string, headers: Record<string, string>) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    await client.close();
  }

  test("identity headers are ignored: a forged token id or scope never reaches the session", async () => {
    const headers = { "X-Midplane-Token-Id": TOKEN_ID, "X-Midplane-Scope": "main:read" };

    // Control: with the default transport the same headers DO reach the session.
    const trusted: Array<{ mcp_token_id: string | null }> = [];
    await connect((await serve({}, trusted)).url, headers);
    expect(trusted[0]!.mcp_token_id).toBe(TOKEN_ID);

    const seen: unknown[] = [];
    const http = await serve({ identityHeaders: false }, seen);
    await connect(http.url, headers);
    expect(seen).toEqual([{ mcp_token_id: null, scope: null }]);
    expect(http.address).toBe("127.0.0.1");
  });

  test("DNS rebinding: a non-loopback Host or Origin is refused before anything is parsed", async () => {
    const http = await serve({ loopbackRequestsOnly: true, identityHeaders: false });
    const post = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: http.port,
            path: "/mcp",
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      });

    expect(await post({ host: `rebind.attacker.example:${http.port}` })).toBe(403);
    expect(await post({ host: `127.0.0.1:${http.port}`, origin: "https://rebind.attacker.example" })).toBe(403);
    expect(await post({ host: `127.0.0.1:${http.port}`, origin: "null" })).toBe(403);
    // Loopback names get through to the MCP layer (which then answers for itself).
    for (const host of [`127.0.0.1:${http.port}`, `localhost:${http.port}`, `[::1]:${http.port}`]) {
      expect(await post({ host })).not.toBe(403);
    }
    expect(await post({ host: `localhost:${http.port}`, origin: `http://localhost:${http.port}` })).not.toBe(403);

    // A real client on loopback is unaffected, and so is the health probe.
    await connect(http.url, {});
    expect((await fetch(`http://127.0.0.1:${http.port}/health`)).status).toBe(200);
  });
});
