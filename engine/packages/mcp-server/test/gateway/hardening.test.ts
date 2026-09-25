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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalUnavailableError, PSEUDONYMIZE_KINDS, type ApprovalRequest } from "@midplane/engine";
import { HttpApprovalGate } from "../../src/approval-gate.ts";
import { buildEngine, type BuiltEngineHandle, type ReplaceDatabase } from "../../src/engine-factory.ts";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";
import { LinkClient } from "../../src/gateway/link-client.ts";
import {
  MAX_BUNDLE_BYTES,
  MAX_CLOCK_SKEW_S,
  generateEd25519KeyPair,
  mintRequestToken,
  privateKeyFromPem,
  publicKeyFromRaw,
  verifyRequestToken,
} from "../../src/gateway/protocol.ts";
import { gatewayCapabilities } from "../../src/gateway/runtime.ts";

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
    const huge = "a".repeat(MAX_BUNDLE_BYTES + 10);
    const declared = await client(() => new Response(huge, { status: 200 })).fetchBundle(signer, null);
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
      { url: "https://cloud.test/api/gateway/v1/approvals", authorize: () => "Bearer t" },
      (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(null, { status: 307, headers: { location: "https://elsewhere.test/approve" } });
      }) as unknown as typeof fetch,
    );
    await expect(gate.request(REQ)).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
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
