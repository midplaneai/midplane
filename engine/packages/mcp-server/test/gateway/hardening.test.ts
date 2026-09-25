// Pre-landing review fixes, each pinned by the behavior it changed:
//
//   • replaced pools are closed, off the apply path
//   • a DSN-variable rename is a full replacement too
//   • halts and dropped databases leave an audit record
//   • "nothing published yet" is a state, not a failure to back off from
//   • response bodies are read with a size cap
//   • the approval gate never follows a redirect
//   • request tokens say how long a replay cache must remember them
//   • `midplane gateway` with any argument never starts (or enrolls)
//   • the capabilities a gateway reports cover every closed vocabulary
//   • approval outcomes are signed and bound to the statement they answer
//   • an approval never outlives the policy that permitted the write, and a
//     write held on an Engine that was since replaced or dropped never runs
//   • waits for a pooled connection are bounded
//   • approval answers are read with a cap, inside the deadline
//   • a body that breaks mid-read is a link failure, not a crashed poll

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalUnavailableError, PSEUDONYMIZE_KINDS, type ApprovalGate, type ApprovalRequest } from "@midplane/engine";
import { HttpApprovalGate, type SignedApprovalGateConfig } from "../../src/approval-gate.ts";
import { buildEngine, type BuiltEngineHandle, type ReplaceDatabase } from "../../src/engine-factory.ts";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";
import { LinkClient } from "../../src/gateway/link-client.ts";
import { signJws } from "../../src/gateway/jws.ts";
import { DEFAULT_CONNECTION_TIMEOUT_MS, PgPoolExecutor } from "../../src/executor/pg-pool.ts";
import {
  MAX_BUNDLE_BYTES,
  MAX_CLOCK_SKEW_S,
  b64urlEncode,
  encodeApprovalOutcome,
  generateEd25519KeyPair,
  keyId,
  mintRequestToken,
  privateKeyFromPem,
  publicKeyFromRaw,
  sqlSha256,
  verifyRequestToken,
  type ApprovalOutcomeClaims,
} from "../../src/gateway/protocol.ts";
import { createGatewayApprovalGate, gatewayCapabilities } from "../../src/gateway/runtime.ts";
import type { StoredIdentity } from "../../src/gateway/state.ts";
import { MockExecutor } from "../_helpers.ts";

const ENV_A = "MIDPLANE_DSN_01AAAAAAAAAAAAAAAAAAAAAAAA";
const ENV_B = "MIDPLANE_DSN_01BBBBBBBBBBBBBBBBBBBBBBBB";

function policy(dbs: Array<{ name: string; env: string }>): string {
  return (
    [
      "databases:",
      ...dbs.flatMap((d) => [
        `  - name: ${d.name}`,
        `    url: \${${d.env}}`,
        "    table_access:",
        "      default: read",
        "      tables: {}",
        "    guardrails:",
        "      block_unqualified_dml: true",
        "      block_ddl: true",
      ]),
    ].join("\n") + "\n"
  );
}

describe("replacePolicy / drain", () => {
  let dir: string;
  let handle: BuiltEngineHandle;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-hardening-"));
    // No injected executor: real, lazy (never connected) pools, so close() is real.
    handle = buildEngine(
      { port: 0, host: "127.0.0.1", dbPath: join(dir, "a.db"), tenantId: "t", transport: "http", maskSourceRewrite: false },
      { startEmpty: true },
    );
  });
  afterEach(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function apply(yaml: string, version: number, env: Record<string, string>) {
    const checked = checkBundlePolicy(yaml);
    if (!checked.ok) throw new Error(checked.reason);
    const dbs: ReplaceDatabase[] = checked.databases.map((d) => ({
      spec: { ...d.spec, url: env[d.dsnEnv] ?? "" },
      dsnEnv: d.dsnEnv,
      configured: Boolean(env[d.dsnEnv]),
    }));
    await handle.replacePolicy(dbs, { bundleVersion: version });
  }

  const rows = () =>
    handle.registry.audit
      .readSince("0", 100)
      .filter((r) => r.event_type === "POLICY_RELOADED")
      .map((r) => ({ db: r.database, payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown> }));

  test("pools replaced by a DSN change or dropped by a bundle are closed, and the apply doesn't wait for them", async () => {
    await apply(policy([{ name: "main", env: ENV_A }, { name: "analytics", env: ENV_B }]), 1, {
      [ENV_A]: "postgres://gw@db/a",
      [ENV_B]: "postgres://gw@db/b",
    });
    const main = handle.registry.get("main").executor as unknown as { close(): Promise<void> };
    const analytics = handle.registry.get("analytics").executor as unknown as { close(): Promise<void> };
    // A close that never resolves stands in for pg's end() waiting on a long query.
    const mainClose = spyOn(main, "close").mockImplementation(() => new Promise(() => {}));
    const analyticsClose = spyOn(analytics, "close").mockImplementation(() => new Promise(() => {}));

    await apply(policy([{ name: "main", env: ENV_A }]), 2, { [ENV_A]: "postgres://gw@db-2/a" });
    expect(mainClose).toHaveBeenCalledTimes(1);
    expect(analyticsClose).toHaveBeenCalledTimes(1);
    expect(handle.registry.names()).toEqual(["main"]);
  });

  test("renaming a database's DSN variable replaces it, even when both are unset", async () => {
    await apply(policy([{ name: "main", env: ENV_A }]), 1, {});
    expect(handle.policySnapshot()[0]!.dsn_env).toBe(ENV_A);
    await apply(policy([{ name: "main", env: ENV_B }]), 2, {});
    expect(handle.policySnapshot()[0]).toMatchObject({ dsn_env: ENV_B, status: "unconfigured" });
    const ctx = { ...handle.registry.get("main").ctxBase, agent_name: "t", agent_version: "1" };
    await expect(handle.registry.get("main").engine.handle({ sql: "SELECT 1", ctx })).rejects.toThrow(ENV_B);
  });

  test("a halt closes every pool, off the apply path", async () => {
    await apply(policy([{ name: "main", env: ENV_A }, { name: "analytics", env: ENV_B }]), 1, {
      [ENV_A]: "postgres://gw@db/a",
      [ENV_B]: "postgres://gw@db/b",
    });
    const closes = ["main", "analytics"].map((db) =>
      spyOn(handle.registry.get(db).executor as unknown as { close(): Promise<void> }, "close").mockImplementation(
        () => new Promise(() => {}),
      ),
    );
    await handle.drain({ bundleVersion: 2, reason: "paused" });
    for (const c of closes) expect(c).toHaveBeenCalledTimes(1);
  });

  test("a dropped database and a halt each leave a POLICY_RELOADED record", async () => {
    await apply(policy([{ name: "main", env: ENV_A }, { name: "analytics", env: ENV_B }]), 1, {});
    await apply(policy([{ name: "main", env: ENV_A }]), 2, {});
    expect(rows().find((r) => r.db === "analytics" && r.payload.removed)).toMatchObject({
      payload: { source: "bundle", removed: true, bundle_version: 2 },
    });

    await handle.drain({ bundleVersion: 3, reason: "this project is paused in Midplane Cloud" });
    expect(handle.registry.count()).toBe(0);
    expect(rows().find((r) => r.db === "main" && r.payload.source === "halt")).toMatchObject({
      payload: { removed: true, bundle_version: 3, reason: "this project is paused in Midplane Cloud" },
    });
  });
});

describe("link client", () => {
  const signer = (() => {
    const pair = generateEd25519KeyPair();
    return { gatewayId: "gw", audience: "https://cloud.test", privateKey: privateKeyFromPem(pair.privateKeyPem) };
  })();
  const client = (respond: () => Response) =>
    new LinkClient("https://cloud.test", "t", (async () => respond()) as unknown as typeof fetch);

  test("404 no_bundle is 'nothing yet', not a failure", async () => {
    const r = await client(() => Response.json({ error: "no_bundle" }, { status: 404 })).fetchBundle(signer, null);
    expect(r).toEqual({ kind: "no_bundle" });
    const other = await client(() => Response.json({ error: "not_found" }, { status: 404 })).fetchBundle(signer, null);
    expect(other).toMatchObject({ kind: "error", status: 404 });
  });

  test("a bundle body larger than a bundle can be is refused while reading", async () => {
    // Declared too large: refused on the header, before reading a byte.
    const declared = await client(
      () => new Response("tiny", { status: 200, headers: { "content-length": String(MAX_BUNDLE_BYTES + 1) } }),
    ).fetchBundle(signer, null);
    expect(declared).toMatchObject({ kind: "error", code: "oversize" });
    // No content-length: the cap still applies while streaming.
    const streamed = await client(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("b".repeat(64 * 1024)));
              c.close();
            },
          }),
          { status: 200 },
        ),
    ).fetchBundle(signer, null);
    expect(streamed).toMatchObject({ kind: "error", code: "oversize" });
  });

  test("a body that breaks mid-read is a link failure (backoff), not a throw", async () => {
    const r = await client(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("eyJ"));
              c.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        ),
    ).fetchBundle(signer, null);
    expect(r).toMatchObject({ kind: "error", status: null, message: expect.stringContaining("connection reset") });
  });

  test("any 2xx carries the enrollment response", async () => {
    const pair = generateEd25519KeyPair();
    const r = await client(() => new Response("h.p.s", { status: 201 })).enroll(
      { token: "mpe1_x" },
      { privateKey: privateKeyFromPem(pair.privateKeyPem), publicKeyRaw: pair.publicKeyRaw },
    );
    expect(r).toEqual({ kind: "enrolled", jws: "h.p.s" });
  });
});

describe("approval gate", () => {
  const REQ = {
    queryId: "q",
    database: "main",
    sql: "UPDATE t SET x = 1 WHERE id = 1",
    intent: "i",
    statementType: "UPDATE",
    tablesTouched: ["t"],
    tenantId: "t",
    agentName: null,
    agentVersion: null,
    mcpTokenId: null,
  } as unknown as ApprovalRequest;

  test("never follows a redirect: the held statement is not re-sent, and a 3xx is 'unavailable'", async () => {
    const seen: RequestInit[] = [];
    const gate = new HttpApprovalGate(
      {
        url: "https://cloud.test/api/gateway/v1/approvals",
        statusUrl: "https://cloud.test/api/gateway/v1/approvals/status",
        authorize: () => "Bearer t",
        verifyOutcome: () => {
          throw new Error("a redirect has no outcome to verify");
        },
      },
      (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(null, { status: 307, headers: { location: "https://elsewhere.test/approve" } });
      }) as unknown as typeof fetch,
    );
    await expect(gate.request(REQ)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
  });

  const answering = (respond: () => Response) =>
    new HttpApprovalGate({ url: "https://cloud.test/approvals", token: "t" }, (async () => respond()) as unknown as typeof fetch);

  test("an answer larger than any outcome is 'unavailable', read with a cap", async () => {
    const body = JSON.stringify({ status: "approved", by: "x", note: "n".repeat(128 * 1024) });
    await expect(answering(() => new Response(body)).request(REQ)).rejects.toThrow(/exceeded/);
    await expect(answering(() => new Response(body)).check("a", null)).rejects.toThrow(/exceeded/);
  });

  // Like a real fetch, the body stream errors when the request's signal aborts,
  // so a stalled body ends only if the gate keeps its deadline armed until the
  // body is read.
  const stalledFetch = (async (_url: string, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(c) {
          init.signal!.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  test("the gate's own deadline covers the body: headers then a stall is 'unavailable', not a hang", async () => {
    // No caller signal: the engine calls request() without one.
    const gate = new HttpApprovalGate({ url: "https://cloud.test/approvals", token: "t" }, stalledFetch, {
      requestMs: 30,
      statusMs: 30,
    });
    await expect(gate.request(REQ)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    await expect(gate.check("a", null)).rejects.toBeInstanceOf(ApprovalUnavailableError);
  });

  test("so does the caller's signal", async () => {
    const gate = new HttpApprovalGate({ url: "https://cloud.test/approvals", token: "t" }, stalledFetch);
    const ctl = new AbortController();
    const pending = gate.request(REQ, ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ApprovalUnavailableError);
  });

  test("the signed gate posts status to its own status route", async () => {
    const urls: string[] = [];
    const gate = new HttpApprovalGate(
      {
        url: "https://cloud.test/approvals",
        statusUrl: "https://cloud.test/elsewhere/status",
        authorize: () => "Bearer t",
        verifyOutcome: () => ({}),
      },
      (async (url: string) => {
        urls.push(url);
        return Response.json({ status: "expired" });
      }) as unknown as typeof fetch,
    );
    expect(await gate.check("a", null)).toEqual({ status: "expired" });
    expect(urls).toEqual(["https://cloud.test/elsewhere/status"]);
  });

  test("signed requests without signed answers is refused at construction", () => {
    expect(
      () => new HttpApprovalGate({ url: "https://cloud.test/a", authorize: () => "Bearer t" } as unknown as SignedApprovalGateConfig),
    ).toThrow(/verifyOutcome/);
  });
});

describe("request tokens", () => {
  test("rememberUntil covers the whole acceptance window, not just exp", () => {
    const pair = generateEd25519KeyPair();
    const b = { audience: "https://cloud.test", method: "GET", path: "/api/gateway/v1/bundle" };
    const tok = mintRequestToken({ ...b, gatewayId: "gw", privateKey: privateKeyFromPem(pair.privateKeyPem), now: 1_000_000 });
    const pub = publicKeyFromRaw(pair.publicKeyRaw);
    const v = verifyRequestToken(tok, pub, { ...b, now: 1_000_000 });
    expect(v.rememberUntil).toBe(v.exp + MAX_CLOCK_SKEW_S);
    // Still accepted just before rememberUntil, refused at it.
    expect(() => verifyRequestToken(tok, pub, { ...b, now: v.rememberUntil - 1 })).not.toThrow();
    expect(() => verifyRequestToken(tok, pub, { ...b, now: v.rememberUntil })).toThrow();
  });
});

describe("capabilities", () => {
  test("report every closed vocabulary the policy schema enforces", () => {
    const caps = gatewayCapabilities();
    expect(caps.pseudonymize_kinds).toEqual([...PSEUDONYMIZE_KINDS]);
    expect(caps.mask_transforms!.length).toBeGreaterThan(0);
    expect(caps.policy_features).toContain("write_approvals");
    expect(caps.bundle_fields).toContain("crit");
  });
});

describe("midplane gateway arguments", () => {
  const CLI = join(import.meta.dirname, "../../src/cli.ts");
  // An enrollment token and an unreachable cloud: if the process ever got as
  // far as enrolling it would fail differently (and would have spent the token).
  const env = {
    PATH: process.env.PATH ?? "",
    MIDPLANE_TELEMETRY: "off",
    MIDPLANE_CLOUD_URL: "http://127.0.0.1:9",
    MIDPLANE_ENROLL_TOKEN: "mpe1_x",
    MIDPLANE_MASK_SALT: "s".repeat(32),
  };

  test("--help prints gateway help and exits 0 without starting", () => {
    const r = spawnSync(process.execPath, [CLI, "gateway", "--help"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("midplane gateway");
    expect(r.stdout).toContain("MIDPLANE_ENROLL_TOKEN");
  });

  test("any other argument is a usage error, not a boot", () => {
    const r = spawnSync(process.execPath, [CLI, "gateway", "--stdio"], { env, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("takes no arguments");
  });

  test("`midplane help gateway` works too", () => {
    const r = spawnSync(process.execPath, [CLI, "help", "gateway"], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("MIDPLANE_GATEWAY_STATE_DIR");
  });
});

describe("signed approval outcomes (gateway mode)", () => {
  const bundleKey = (() => {
    const pair = generateEd25519KeyPair();
    return { kid: keyId(pair.publicKeyRaw), raw: pair.publicKeyRaw, privateKey: privateKeyFromPem(pair.privateKeyPem) };
  })();
  const gatewayPair = generateEd25519KeyPair();
  const identity: StoredIdentity = {
    v: 1,
    gateway_id: "01GATEWAYAAAAAAAAAAAAAAAAA",
    project_id: "01PROJECTAAAAAAAAAAAAAAAAA",
    cloud_url: "https://cloud.test",
    issuer: "https://cloud.test",
    gateway_key: b64urlEncode(gatewayPair.publicKeyRaw),
    signing_key: { kid: bundleKey.kid, x: b64urlEncode(bundleKey.raw) },
    min_version: 1,
    poll_seconds: 15,
    enrolled_at: 1,
  };
  const REQ = {
    queryId: "01QUERYAAAAAAAAAAAAAAAAAAA",
    database: "main",
    sql: "DELETE FROM orders WHERE id = 1",
    intent: "i",
    statementType: "DELETE",
    tablesTouched: ["orders"],
    tenantId: "t",
    agentName: null,
    agentVersion: null,
    mcpTokenId: null,
  } as unknown as ApprovalRequest;

  function signed(over: Partial<ApprovalOutcomeClaims> = {}, key = bundleKey): string {
    const iat = Math.floor(Date.now() / 1000);
    return encodeApprovalOutcome(
      {
        iss: identity.issuer,
        project_id: identity.project_id,
        gateway_id: identity.gateway_id,
        query_id: REQ.queryId,
        sql_sha256: sqlSha256(REQ.sql),
        iat,
        exp: iat + 60,
        outcome: { status: "approved", by: "ada@example.com", note: null },
        ...over,
      },
      { kid: key.kid, privateKey: key.privateKey },
    );
  }

  function gateAnswering(body: string) {
    return createGatewayApprovalGate({
      cloudUrl: "https://cloud.test",
      client: new LinkClient("https://cloud.test", "t"),
      identity,
      privateKey: privateKeyFromPem(gatewayPair.privateKeyPem),
      fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    });
  }

  test("a signed outcome bound to this statement is honoured", async () => {
    expect(await gateAnswering(signed()).request(REQ)).toMatchObject({ status: "approved", by: "ada@example.com" });
  });

  test.each([
    ["an unsigned 'approved' (what a TLS-intercepting proxy could say)", () => JSON.stringify({ status: "approved", by: "mitm" })],
    ["an outcome signed by another key", () => {
      const other = generateEd25519KeyPair();
      return signed({}, { kid: bundleKey.kid, raw: other.publicKeyRaw, privateKey: privateKeyFromPem(other.privateKeyPem) });
    }],
    ["an outcome for another attempt (replayed approval)", () => signed({ query_id: "01OTHERQUERYAAAAAAAAAAAAAA" })],
    ["an outcome for different SQL bytes", () => signed({ sql_sha256: sqlSha256("DELETE FROM orders WHERE id = 2") })],
    ["an outcome for another gateway", () => signed({ gateway_id: "01OTHERGATEWAYAAAAAAAAAAAA" })],
    ["an expired outcome", () => {
      const iat = Math.floor(Date.now() / 1000) - 1000;
      return signed({ iat, exp: iat + 60 });
    }],
  ])("%s is 'unavailable', never permission", async (_label, body) => {
    await expect(gateAnswering(body()).request(REQ)).rejects.toBeInstanceOf(ApprovalUnavailableError);
  });

  // Hand-signed with the REAL key, so each case isolates one claim check.
  // `over` may be a function of the iat the payload uses, so a time-relative
  // case can't straddle a second boundary.
  type Over = Record<string, unknown> | ((iat: number) => Record<string, unknown>);
  function handSigned(over: Over, typ = "midplane-approval+jws"): string {
    const iat = Math.floor(Date.now() / 1000);
    const extra = typeof over === "function" ? over(iat) : over;
    return signJws(
      { alg: "EdDSA", typ, kid: bundleKey.kid },
      JSON.stringify({
        v: 1,
        iss: identity.issuer,
        project_id: identity.project_id,
        gateway_id: identity.gateway_id,
        query_id: REQ.queryId,
        sql_sha256: sqlSha256(REQ.sql),
        iat,
        exp: iat + 60,
        outcome: { status: "approved", by: "ada@example.com", note: null },
        ...extra,
      }),
      bundleKey.privateKey,
    );
  }

  test("the hand-signed control verifies", async () => {
    expect(await gateAnswering(handSigned({})).request(REQ)).toMatchObject({ status: "approved" });
  });

  test.each([
    ["another control plane", { iss: "https://other.test" }],
    ["another project", { project_id: "01OTHERPROJECTAAAAAAAAAAAA" }],
    ["issued in the future", (iat: number) => ({ iat: iat + 3600, exp: iat + 3660 })],
    ["valid for longer than 300 s", (iat: number) => ({ exp: iat + 301 })],
    ["a format this gateway doesn't know", { v: 2 }],
    ["no outcome object", { outcome: "approved" }],
  ] as Array<[string, Over]>)("an outcome for %s is refused", async (_label, over) => {
    await expect(gateAnswering(handSigned(over)).request(REQ)).rejects.toBeInstanceOf(ApprovalUnavailableError);
  });

  test("a bundle signed where an approval belongs (wrong typ) is refused", async () => {
    await expect(gateAnswering(handSigned({}, "midplane-bundle+jws")).request(REQ)).rejects.toBeInstanceOf(
      ApprovalUnavailableError,
    );
  });

  test("signed pending and denied outcomes come through as themselves", async () => {
    const expiresAt = Date.now() + 600_000;
    expect(
      await gateAnswering(
        signed({ outcome: { status: "pending", approval_id: "01APPROVALAAAAAAAAAAAAAAAA", expires_at: expiresAt } }),
      ).request(REQ),
    ).toEqual({ status: "pending", approvalId: "01APPROVALAAAAAAAAAAAAAAAA", expiresAt });
    expect(
      await gateAnswering(signed({ outcome: { status: "denied", by: "ada@example.com", note: "use refunds" } })).request(REQ),
    ).toEqual({ status: "denied", by: "ada@example.com", note: "use refunds" });
  });

  test("the control plane can't sign what a gateway would refuse to read", () => {
    const bad = (over: Record<string, unknown>) => () => signed(over as Partial<ApprovalOutcomeClaims>);
    expect(bad({ outcome: { status: "pending" } })).toThrow(/approval_id/);
    expect(bad({ outcome: { status: "pending", approval_id: "a", expires_at: Math.floor(Date.now() / 1000) } })).toThrow(/ms since the epoch/);
    expect(bad({ outcome: { status: "consumed" } })).toThrow(/status/);
    expect(bad({ iat: Date.now() / 1000 })).toThrow(/integers/);
    expect(bad({ query_id: "" })).toThrow(/query_id/);
    expect(bad({ sql_sha256: "abc" })).toThrow(/sql_sha256/);
    expect(bad({ outcome: { status: "denied", by: null, note: "n".repeat(64 * 1024) } })).toThrow(/exceeds/);
  });
});

describe("policy re-check after an approval", () => {
  let dir: string;
  let handle: BuiltEngineHandle;
  let executor: MockExecutor;
  afterEach(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function yaml(tableDefault: "read" | "read_write", masks = false): string {
    return [
      "databases:",
      "  - name: main",
      `    url: \${${ENV_A}}`,
      "    table_access:",
      `      default: ${tableDefault}`,
      "      tables: {}",
      "    guardrails:",
      "      block_unqualified_dml: true",
      "      block_ddl: true",
      "    requires_features:",
      "      - write_approvals",
      ...(masks ? ["      - column_masks"] : []),
      "    approvals:",
      "      writes: true",
      ...(masks ? ["    column_masks:", "      public.users:", "        email: full-redact"] : []),
      "",
    ].join("\n");
  }

  async function apply(tableDefault: "read" | "read_write", version: number, masks = false) {
    const checked = checkBundlePolicy(yaml(tableDefault, masks));
    if (!checked.ok) throw new Error(checked.reason);
    await handle.replacePolicy(
      checked.databases.map((d) => ({ spec: { ...d.spec, url: "postgres://stub" }, dsnEnv: d.dsnEnv, configured: true })),
      { bundleVersion: version },
    );
  }

  function build(onRequest: () => Promise<void>) {
    dir = mkdtempSync(join(tmpdir(), "midplane-recheck-"));
    // query(): masked databases need a catalog resolver; nothing here reads it.
    executor = Object.assign(new MockExecutor(), { query: async () => [] });
    const gate: ApprovalGate = {
      async request() {
        await onRequest();
        return { status: "approved", by: "ada@example.com", note: null };
      },
    };
    handle = buildEngine(
      { port: 0, host: "127.0.0.1", dbPath: join(dir, "a.db"), tenantId: "t", transport: "http", maskSourceRewrite: false, maskSalt: "s".repeat(32) },
      { startEmpty: true, executor, approvalGate: gate },
    );
  }

  const WRITE = "UPDATE orders SET status = 'x' WHERE id = 1";
  const run = () => {
    const e = handle.registry.get("main");
    return e.engine.handle({ sql: WRITE, ctx: { ...e.ctxBase, agent_name: "t", agent_version: "1" } });
  };

  test("a tightening that lands while the write waits for a human wins: the approved write is denied, not run", async () => {
    // The lockdown (orders read-only) arrives during the approval hold.
    build(() => apply("read", 2));
    await apply("read_write", 1);
    const decision = await run();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("table_access");
    expect(executor.calls).toHaveLength(0);
    const decided = handle.registry.audit.readSince("0", 100).filter((r) => r.event_type === "DECIDED");
    expect(JSON.stringify(decided.at(-1)!.payload)).toContain("table_access");
  });

  // A bundle that REBUILDS the Engine (masks changed) retires the one holding
  // the write: its masks are stale and later bundles never reach it, so the
  // approved write is refused and the agent re-runs on the live Engine.
  const replaced = async () => {
    const decision = await run();
    expect(decision).toMatchObject({ allowed: false, reason: "policy_replaced" });
    expect(executor.calls).toHaveLength(0);
  };

  test("masks change while the write waits: refused, not run with the old masks", async () => {
    build(() => apply("read_write", 2, true));
    await apply("read_write", 1);
    const before = handle.registry.get("main").engine;
    await replaced();
    expect(handle.registry.get("main").engine).not.toBe(before);
  });

  test("two bundles while the write waits — a mask rebuild, then a tightening — still refused", async () => {
    build(async () => {
      await apply("read_write", 2, true);
      await apply("read", 3, true);
    });
    await apply("read_write", 1);
    await replaced();
  });

  test("a bundle that drops the database while the write waits: refused, not run", async () => {
    build(async () => {
      await handle.replacePolicy([], { bundleVersion: 2 });
    });
    await apply("read_write", 1);
    await replaced();
  });

  test("a halt while the write waits: refused, not run", async () => {
    build(() => handle.drain({ bundleVersion: 2, reason: "paused" }));
    await apply("read_write", 1);
    await replaced();
  });

  test("after a rebuild the re-run is judged by the live Engine", async () => {
    build(async () => {});
    await apply("read_write", 1, true);
    const retired = handle.registry.get("main").engine;
    await apply("read_write", 2); // masks off: a rebuild
    expect(handle.registry.get("main").engine).not.toBe(retired);
    expect((await run()).allowed).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  test("without a change in policy, the approved write runs", async () => {
    build(async () => {});
    await apply("read_write", 1);
    expect((await run()).allowed).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });
});

describe("pool connection timeout", () => {
  test("pooled connection waits are bounded (30 s by default)", async () => {
    const ex = new PgPoolExecutor({ databaseUrl: "postgres://stub@127.0.0.1:1/x" });
    expect((ex as unknown as { pool: { options: { connectionTimeoutMillis: number } } }).pool.options.connectionTimeoutMillis).toBe(
      DEFAULT_CONNECTION_TIMEOUT_MS,
    );
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBe(30_000);
    await ex.close();
  });
});
