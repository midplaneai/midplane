// Gateway runtime edge paths the main runtime suite doesn't reach: a bundle
// that can't be persisted, one that verifies but can't be applied, the link's
// failure modes (clock skew, revocation, backoff), a session that predates the
// first policy, the guard's robustness, the signed approval-status call, and
// every enrollment failure an operator can actually hit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEngine, type BuiltEngineHandle } from "../../src/engine-factory.ts";
import { ensureIdentity, type LoadedIdentity } from "../../src/gateway/enroll.ts";
import { LinkClient } from "../../src/gateway/link-client.ts";
import { EnrollmentError, generateEd25519KeyPair, mintEnrollmentToken } from "../../src/gateway/protocol.ts";
import { GatewayRuntime, createGatewayApprovalGate, type RuntimeLogger } from "../../src/gateway/runtime.ts";
import { GatewayStateDir } from "../../src/gateway/state.ts";
import { buildServer } from "../../src/server.ts";
import { MockExecutor } from "../_helpers.ts";
import { FakeCloud } from "./_fake-cloud.ts";

const MAIN_ENV = "MIDPLANE_DSN_01MAINAAAAAAAAAAAAAAAAAAAA";
const ANALYTICS_ENV = "MIDPLANE_DSN_01ANALYTICSAAAAAAAAAAAAAAA";
const MAIN_DSN = "postgres://gateway:hunter2@db.internal:5432/app";

type Call = { level: string; obj: object; msg: string };

function recordingLog(): RuntimeLogger & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = (level: string) => (obj: object, msg: string) => void calls.push({ level, obj, msg });
  return { calls, info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
}

function policy(o: { approvals?: boolean; masks?: boolean; analytics?: boolean } = {}): string {
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
  const features = [...(o.approvals ? ["write_approvals"] : []), ...(o.masks ? ["column_masks"] : [])];
  const extra = [
    ...(features.length ? ["    requires_features:", ...features.map((f) => `      - ${f}`)] : []),
    ...(o.approvals ? ["    approvals:", "      writes: true"] : []),
    ...(o.masks ? ["    column_masks:", "      public.users:", "        email: full-redact"] : []),
  ];
  return ["databases:", ...db("main", MAIN_ENV, extra), ...(o.analytics ? db("analytics", ANALYTICS_ENV) : [])].join("\n") + "\n";
}

type Tools = Record<string, { handler: (a: unknown) => Promise<unknown> }>;
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

function toolsOf(server: ReturnType<typeof buildServer>): Tools {
  return (server as unknown as { _registeredTools: Tools })._registeredTools;
}

describe("gateway runtime — edge paths", () => {
  let cloud: FakeCloud;
  let dir: string;
  let stateDir: string;
  const open: Array<{ handle: BuiltEngineHandle; runtime?: GatewayRuntime }> = [];

  beforeEach(async () => {
    cloud = await FakeCloud.start();
    dir = mkdtempSync(join(tmpdir(), "midplane-gw-edge-"));
    stateDir = join(dir, "state");
  });

  afterEach(async () => {
    try {
      chmodSync(stateDir, 0o700);
    } catch {
      // not created by this test
    }
    for (const g of open.splice(0)) {
      g.runtime?.stop();
      await g.handle.close();
    }
    await cloud.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  async function enroll(cloudUrl = cloud.origin, state = GatewayStateDir.open(stateDir)): Promise<LoadedIdentity> {
    return ensureIdentity(
      state,
      new LinkClient(cloudUrl, "midplane-gateway/test"),
      { cloudUrl, enrollToken: cloud.mintToken(), name: "t", engineVersion: "0.0.0-test", capabilities: {} },
      recordingLog(),
    );
  }

  function engine(opts: { maskSalt?: string; executor?: MockExecutor; gateFor?: LoadedIdentity } = {}) {
    const approvalGate = opts.gateFor
      ? createGatewayApprovalGate({
          cloudUrl: cloud.origin,
          client: new LinkClient(cloud.origin, "t"),
          identity: opts.gateFor.identity,
          privateKey: opts.gateFor.privateKey,
        })
      : undefined;
    return buildEngine(
      {
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, `audit-${open.length}-${Math.random().toString(36).slice(2)}.db`),
        tenantId: "__self_host__",
        transport: "http",
        maskSalt: "maskSalt" in opts ? opts.maskSalt : "s".repeat(32),
        maskSourceRewrite: false,
      },
      { startEmpty: true, executor: opts.executor ?? new MockExecutor(), approvalGate },
    );
  }

  function runtime(
    enrolled: LoadedIdentity,
    handle: BuiltEngineHandle,
    o: { client?: LinkClient; log?: RuntimeLogger; env?: NodeJS.ProcessEnv; state?: GatewayStateDir } = {},
  ): GatewayRuntime {
    const rt = new GatewayRuntime({
      identity: enrolled.identity,
      privateKey: enrolled.privateKey,
      state: o.state ?? GatewayStateDir.open(stateDir),
      client: o.client ?? new LinkClient(cloud.origin, "midplane-gateway/test"),
      handle,
      env: o.env ?? { [MAIN_ENV]: MAIN_DSN },
      pollSeconds: 15,
      engineVersion: "0.0.0-test",
      runtimeLabel: "bun test",
      installShape: "source",
      tenantId: "__self_host__",
      log: o.log ?? recordingLog(),
    });
    open.push({ handle, runtime: rt });
    return rt;
  }

  // ── persistence ─────────────────────────────────────────────────────────

  // Root ignores directory modes, so the unwritable dir can't be simulated there.
  test.skipIf(process.getuid?.() === 0)("a bundle that can't be written to disk is still enforced, reported, and persisted on the next poll", async () => {
    cloud.publish(policy());
    const enrolled = await enroll();
    const handle = engine();
    const rt = runtime(enrolled, handle);
    await rt.bootFromCache();
    expect(await rt.pollOnce()).toBe("bundle");
    const bundlePath = join(stateDir, "bundle.jws");
    expect(readFileSync(bundlePath, "utf8")).toBe(cloud.published[0]!);

    // v2 turns approvals on; the state dir goes read-only before it arrives.
    cloud.publish(policy({ approvals: true }));
    chmodSync(stateDir, 0o500);
    expect(await rt.pollOnce()).toBe("bundle");
    expect(rt.state).toBe("serving");
    expect(handle.policySnapshot()[0]!.approvals.row_changes).toBe(true); // applied anyway
    expect(rt.heartbeat().persist_error).toEqual(expect.any(String));
    expect(readFileSync(bundlePath, "utf8")).toBe(cloud.published[0]!); // disk still v1

    // Disk writable again: the next poll (a 304) retries the write first.
    chmodSync(stateDir, 0o700);
    expect(await rt.pollOnce()).toBe("not_modified");
    expect(rt.heartbeat().persist_error).toBeNull();
    expect(readFileSync(bundlePath, "utf8")).toBe(cloud.published[1]!);

    // So a restart with the cloud down comes back on v2, not v1.
    rt.stop();
    await cloud.stop();
    const handle2 = engine();
    const rt2 = runtime(enrolled, handle2, { client: new LinkClient(cloud.origin, "t") });
    await rt2.bootFromCache();
    expect(rt2.state).toBe("serving");
    expect(handle2.policySnapshot()[0]!.approvals.row_changes).toBe(true);
  });

  // ── apply failure ───────────────────────────────────────────────────────

  test("an authentic bundle the engine can't build halts and drains; the next buildable one serves again", async () => {
    cloud.publish(policy());
    const enrolled = await enroll();
    // No salt: a masked database can't be built.
    const handle = engine({ maskSalt: undefined });
    const log = recordingLog();
    const rt = runtime(enrolled, handle, { log });
    await rt.bootFromCache();
    await rt.pollOnce();
    expect(rt.state).toBe("serving");

    cloud.publish(policy({ masks: true }));
    expect(await rt.pollOnce()).toBe("bundle");
    expect(rt.state).toBe("halted");
    expect(rt.ready()).toMatchObject({ status: 503, body: { state: "halted" } });
    expect(String(rt.heartbeat().halt_reason)).toMatch(/v2 could not be applied: .*MIDPLANE_MASK_SALT/);
    expect(rt.heartbeat().bundle).toBeNull();
    expect(handle.registry.count()).toBe(0);
    // Halting on it still counts as holding it: the cache is v2.
    expect(readFileSync(join(stateDir, "bundle.jws"), "utf8")).toBe(cloud.published[1]!);
    expect(log.calls.some((c) => c.level === "error" && c.msg.includes("halted"))).toBe(true);

    cloud.publish(policy());
    await rt.pollOnce();
    expect(rt.state).toBe("serving");
    expect(rt.heartbeat()).toMatchObject({ bundle: { version: 3 }, halt_reason: null });
  });

  // ── the link's failure modes ───────────────────────────────────────────

  test("clock skew and revocation are named in the logs; failures back off and cap; success resets", async () => {
    const enrolled = await enroll();
    let next: () => Response = () => new Response(null, { status: 304 });
    const stub = (async () => next()) as unknown as typeof fetch;
    const log = recordingLog();
    const rt = runtime(enrolled, engine(), { client: new LinkClient(cloud.origin, "t", stub), log });
    const delay = () => (rt as unknown as { nextDelayMs(): number }).nextDelayMs();
    const json = (status: number, body: unknown) => () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // Clock skew: logged as an error with the measured offset.
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    next = json(401, { error: "clock_skew", server_time: hourAgo });
    expect(await rt.pollOnce()).toBe("error");
    const skew = log.calls.find((c) => c.msg.includes("clock"));
    expect(skew?.level).toBe("error");
    expect(Math.abs((skew!.obj as { skew_seconds: number }).skew_seconds - 3600)).toBeLessThanOrEqual(2);
    // One failure doubles the 15 s interval (±20% jitter).
    const d1 = delay();
    expect(d1).toBeGreaterThanOrEqual(24_000);
    expect(d1).toBeLessThanOrEqual(36_000);

    // Many failures cap at 300 s.
    next = json(503, { error: "unavailable" });
    for (let i = 0; i < 6; i++) await rt.pollOnce();
    // The cap holds after jitter: no draw may exceed it.
    for (let i = 0; i < 20; i++) expect(delay()).toBeLessThanOrEqual(300_000);
    expect(delay()).toBeGreaterThanOrEqual(240_000);

    // Success resets the backoff.
    next = () => new Response(null, { status: 304 });
    expect(await rt.pollOnce()).toBe("not_modified");
    expect(delay()).toBeGreaterThanOrEqual(12_000);
    expect(delay()).toBeLessThanOrEqual(18_000);

    // Revocation: logged once, not on every poll, and the poll slows to 5 min.
    next = json(401, { error: "gateway_revoked" });
    await rt.pollOnce();
    await rt.pollOnce();
    expect(log.calls.filter((c) => c.msg.includes("revoked"))).toHaveLength(1);
    expect(delay()).toBeGreaterThanOrEqual(240_000);
    // …until the cloud answers again.
    next = () => new Response(null, { status: 304 });
    await rt.pollOnce();
    expect(delay()).toBeLessThanOrEqual(18_000);

    // A failed heartbeat is a false, logged as a heartbeat problem.
    next = json(500, { error: "boom" });
    expect(await rt.sendHeartbeat()).toBe(false);
    expect(log.calls.some((c) => c.level === "warn" && c.msg.startsWith("heartbeat:"))).toBe(true);
  });

  test("an identity whose pinned key doesn't match its kid is refused at construction", async () => {
    const enrolled = await enroll();
    const tampered = {
      ...enrolled,
      identity: { ...enrolled.identity, signing_key: { ...enrolled.identity.signing_key, kid: "AAAAAAAAAAAAAAAA" } },
    };
    const handle = engine();
    open.push({ handle });
    expect(() => runtime(tampered, handle)).toThrow(/does not match its kid/);
  });

  // ── the tool surface around state changes ──────────────────────────────

  test("a session opened before the first policy tells the agent to reconnect; a new session serves", async () => {
    cloud.publish(policy());
    const enrolled = await enroll();
    const executor = new MockExecutor();
    const handle = engine({ executor });
    const rt = runtime(enrolled, handle);
    await rt.bootFromCache();

    const early = toolsOf(buildServer({ handle, serving: rt.servingGuard() }));
    expect(Object.keys(early).sort()).toEqual(["describe_table", "list_databases", "list_tables", "query"]);

    await rt.pollOnce();
    expect(rt.state).toBe("serving");
    const stale = (await early.query!.handler({ sql: "SELECT 1", intent: "t" })) as ToolResult;
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({ allowed: false, policy_rule: "gateway_state" });
    expect(stale.content[0]!.text).toContain("Reconnect");
    expect(executor.calls).toHaveLength(0);

    const fresh = toolsOf(buildServer({ handle, serving: rt.servingGuard() }));
    const ok = (await fresh.query!.handler({ sql: "SELECT id FROM orders", intent: "t" })) as ToolResult;
    expect(ok.isError).toBeFalsy();
    expect(executor.calls).toHaveLength(1);
  });

  test("the guard refuses every tool, check_approval included, even when its audit write fails", async () => {
    cloud.publish(policy({ approvals: true, analytics: true }));
    const enrolled = await enroll();
    const handle = engine({ gateFor: enrolled });
    const rt = runtime(enrolled, handle, { env: { [MAIN_ENV]: MAIN_DSN, [ANALYTICS_ENV]: MAIN_DSN } });
    await rt.bootFromCache();
    await rt.pollOnce();

    const refusals: unknown[] = [];
    let mode: "throw" | "reject" | "record" = "throw";
    const tools = toolsOf(
      buildServer({
        handle,
        approvalGate: handle.approvalGate,
        serving: {
          check: () => ({ ok: false, reason: "halted for the test" }),
          onRefused: (r) => {
            if (mode === "throw") throw new Error("audit down");
            if (mode === "reject") return Promise.reject(new Error("audit down"));
            refusals.push(r);
          },
        },
      }),
    );
    expect(tools.check_approval).toBeDefined();

    for (const m of ["throw", "reject"] as const) {
      mode = m;
      const res = (await tools.query!.handler({ database: "main", sql: "SELECT 1", intent: "t" })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0]!.text)).toEqual({ allowed: false, policy_rule: "gateway_state", reason: "halted for the test" });
    }

    // Every registered tool goes through the guard — the point of one seam.
    mode = "record";
    const args = { database: "main", sql: "SELECT 1", intent: "t", table: "x", approval_id: "a" };
    for (const [name, t] of Object.entries(tools)) {
      const r = (await t.handler(args)) as ToolResult;
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).policy_rule).toBe("gateway_state");
      expect(name.length).toBeGreaterThan(0);
    }
    expect(refusals.length).toBe(Object.keys(tools).length);
    refusals.length = 0;

    const held = (await tools.check_approval!.handler({ approval_id: "apr_1" })) as ToolResult;
    expect(held.isError).toBe(true);
    await tools.query!.handler({ database: "analytics", sql: "SELECT 1", intent: "why" });
    expect(refusals).toEqual([
      expect.objectContaining({ tool: "check_approval", database: null, intent: null }),
      expect.objectContaining({ tool: "query", database: "analytics", intent: "why", reason: "halted for the test" }),
    ]);
    expect(cloud.requests.filter((r) => r.includes("approvals"))).toHaveLength(0);
  });

  test("check_approval's status call is signed for its own path and body, and the cloud accepts it", async () => {
    cloud.publish(policy({ approvals: true }));
    const enrolled = await enroll();
    const handle = engine({ gateFor: enrolled });
    const rt = runtime(enrolled, handle);
    await rt.bootFromCache();
    await rt.pollOnce();

    // The fake cloud verifies the request token against method, path and body;
    // a token minted for /approvals would be refused on /approvals/status.
    expect(await handle.approvalGate!.check!("apr_1", null)).toEqual({ status: "expired" });
    expect(cloud.requests).toContain("POST /api/gateway/v1/approvals/status");
  });

  // ── enrollment failures an operator can hit ─────────────────────────────

  describe("enrollment failures", () => {
    async function attempt(token: string, at: string) {
      const state = GatewayStateDir.open(join(dir, at));
      const p = ensureIdentity(
        state,
        new LinkClient(cloud.origin, "t"),
        { cloudUrl: cloud.origin, enrollToken: token, name: "t", engineVersion: "0", capabilities: {} },
        recordingLog(),
      );
      return { p, state };
    }

    test("each refusal names its cause; nothing but the key is written, and a bad token sends nothing", async () => {
      // A malformed token: refused before a key is generated or anything is sent.
      const bad = await attempt("mpe1_not-a-token", "bad");
      await expect(bad.p).rejects.toThrow(EnrollmentError);
      expect(existsSync(bad.state.keyPath)).toBe(false);
      expect(cloud.requests).toHaveLength(0);

      // A token this control plane never issued: points at the region.
      const foreign = await attempt(mintEnrollmentToken(cloud.bundleKey.raw), "foreign");
      await expect(foreign.p).rejects.toThrow(/not valid for this control plane .*MIDPLANE_CLOUD_URL/);

      // A token another gateway already used: the key stays (for a retry), no identity.
      const token = cloud.mintToken();
      await (await attempt(token, "first")).p;
      const used = await attempt(token, "second");
      await expect(used.p).rejects.toThrow(/already used by another gateway/);
      expect(existsSync(used.state.keyPath)).toBe(true);
      expect(existsSync(used.state.identityPath)).toBe(false);

      // An unreachable control plane: an enrollment failure, not a crash.
      const late = cloud.mintToken();
      await cloud.stop();
      const down = await attempt(late, "down");
      await expect(down.p).rejects.toThrow(/enrollment failed: control plane unreachable/);
    });

    test("an enrolled gateway pointed at a different origin refuses to boot instead of talking to it", async () => {
      // Its tokens are bound to the enrolled issuer, and the other origin (maybe
      // another region) would receive held statements and heartbeats.
      await enroll();
      await expect(
        ensureIdentity(
          GatewayStateDir.open(stateDir),
          new LinkClient("https://us.app.midplane.test", "t"),
          { cloudUrl: "https://us.app.midplane.test", enrollToken: null, name: "t", engineVersion: "0", capabilities: {} },
          recordingLog(),
        ),
      ).rejects.toThrow(/enrolled against/);
    });

    test("a state dir whose key isn't the enrolled one refuses to boot", async () => {
      await enroll();
      const state = GatewayStateDir.open(stateDir);
      writeFileSync(state.keyPath, generateEd25519KeyPair().privateKeyPem);
      await expect(
        ensureIdentity(
          state,
          new LinkClient(cloud.origin, "t"),
          { cloudUrl: cloud.origin, enrollToken: null, name: "t", engineVersion: "0", capabilities: {} },
          recordingLog(),
        ),
      ).rejects.toThrow(/not the key this gateway enrolled with/);
    });
  });
});
