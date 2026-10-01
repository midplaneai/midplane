// Linked mode end to end, against Postgres and a stand-in cloud: enrollment
// with a pinned key, bundles as full replacements, invariants 7, 8 and 12,
// pause, commands, and a restart with the cloud down.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadParser } from "@midplane/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSigningKey } from "../src/auth.ts";
import { parseLinkedConfig } from "../src/config.ts";
import { MCP_PATH } from "../src/http.ts";
import { EnrollmentError } from "../src/identity.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
import {
  callTool,
  createDatabase,
  hasPostgres,
  query,
  type TestDatabase,
} from "./harness.ts";
import { localFetch } from "./tunnel.ts";

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
  ms = 5_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const READ_ALL = {
  table_access: {
    tables: { "public.users": "read", "public.notes": "read_write" },
  },
  masks: {
    "public.users": { id: "none", name: "none", email: "full-redact" },
  },
};

describe.skipIf(!hasPostgres)("linked mode", { timeout: 20_000 }, () => {
  let db: TestDatabase;
  let cloud: FakeCloud;
  let dir: string;
  let port: number;
  let gw: RunningGateway;
  let connections = 0;
  const env: NodeJS.ProcessEnv = {};

  const config = () => {
    const text = JSON.stringify({
      listen: { host: "127.0.0.1", port },
      audit: { file: "audit.db" },
      mask_salt: { env: "SALT" },
      link: {
        cloud_url: cloud.url,
        identity: { file: "identity.json" },
        enrollment_token: { env: "ENROLL" },
        name: "test gateway",
      },
      databases: { main: { dsn: { env: "DSN_MAIN" } } },
    });
    const path = join(dir, "midplane.yaml");
    writeFileSync(path, text);
    return parseLinkedConfig(text, path, env);
  };

  /** Start (or restart) the gateway; inbound connections are refused and counted. */
  const start = () =>
    startLinked(config(), {
      retry: { minMs: 50, maxMs: 200, cutMs: 200 },
      onServer: (server) =>
        server.on("connection", (socket) => {
          if (blockInbound) {
            connections++;
            (socket as { destroy(): void }).destroy();
          }
        }),
    });
  let blockInbound = false;

  const mcpUrl = () => `http://127.0.0.1:${port}${MCP_PATH}`;
  const agent = (o: Parameters<FakeCloud["agentToken"]>[0] | object = {}) =>
    cloud.agentToken({ audience: mcpUrl(), ...o });
  const version = () => gw.link?.version ?? null;

  beforeAll(async () => {
    await loadParser();
    db = await createDatabase(
      `CREATE TABLE users (id int PRIMARY KEY, name text, email text);
       INSERT INTO users VALUES (1, 'Alice', 'alice@example.com');
       CREATE TABLE notes (id serial PRIMARY KEY, body text);`,
      (role) =>
        `GRANT SELECT, INSERT, UPDATE, DELETE ON users, notes TO ${role};
         GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
    );
    cloud = await startFakeCloud();
    dir = mkdtempSync(join(tmpdir(), "midplane-linked-"));
    port = await freePort();
    env.SALT = randomBytes(32).toString("hex");
    env.DSN_MAIN = db.agentDsn;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await cloud?.close();
    await db?.drop();
  });

  it("refuses an enrollment answer signed with a key the token doesn't pin", async () => {
    // The cloud accepts the token but answers with a key other than the
    // one it pins, as it would look through a proxy that re-signs.
    env.ENROLL = cloud.enrollmentToken({ pin: Buffer.alloc(32, 7) });
    const failed = start();
    await expect(failed).rejects.toThrow(EnrollmentError);
    await expect(failed).rejects.toThrow(/doesn't pin/);
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
  });

  it("enrolls, then serves nothing until a bundle arrives", async () => {
    env.ENROLL = cloud.enrollmentToken();
    blockInbound = false;
    gw = await start();
    expect(existsSync(join(dir, "identity.json"))).toBe(true);
    expect(gw.gateway.enforcement.state).toBe("waiting");
    const res = await fetch(mcpUrl(), { method: "POST" });
    expect(res.status).toBe(503);
    expect((await fetch(`${gw.url}/readyz`)).status).toBe(503);
    await waitFor("a status", () => cloud.statuses.length > 0);
    expect(cloud.statuses.at(-1)).toMatchObject({
      bundle_version: null,
      state: "waiting",
      databases: ["main"],
      resources: [mcpUrl()],
    });
    expect(cloud.registered).toEqual([mcpUrl()]);
  });

  it("invariant 12: gets bundles and commands with every inbound connection refused", async () => {
    blockInbound = true;
    const { version: v } = await cloud.publish({ main: READ_ALL });
    await waitFor("the first bundle", () => version() === v);
    const id = cloud.command("test_connection");
    await waitFor("the command result", () => cloud.results.has(id));
    expect(cloud.results.get(id)).toMatchObject({
      ok: true,
      result: { databases: { main: { ok: true, code: null } } },
    });
    const unknown = cloud.command("drop_everything");
    await waitFor("the refusal", () => cloud.results.has(unknown));
    expect(cloud.results.get(unknown)).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(connections).toBe(0);
    blockInbound = false;
    // Nor is there anything for the cloud to call.
    for (const path of ["/link/v1/sync", "/link/v1/commands/x", "/bundle"]) {
      const r = await fetch(`${gw.url}${path}`, { method: "POST" });
      expect(r.status).toBe(404);
    }
  });

  it("enforces the bundle: masks, table access, and its token keys", async () => {
    expect(gw.gateway.enforcement.state).toBe("enforcing");
    expect((await fetch(`${gw.url}/readyz`)).status).toBe(200);
    const r = await query(mcpUrl(), await agent(), "SELECT email FROM users");
    expect(r.structuredContent?.rows).toEqual([["***"]]);
    const w = await query(
      mcpUrl(),
      await agent(),
      "INSERT INTO notes (body) VALUES ('hi')",
    );
    expect(w.isError).toBeFalsy();
  });

  it("switched-off sections reach a running gateway", async () => {
    // Masks off, notes gone from table access: a full replacement, so the
    // missing sections are really off, not left as they were.
    const { version: v } = await cloud.publish({
      main: { table_access: { tables: { "public.users": "read" } } },
    });
    await waitFor("the new bundle", () => version() === v);
    const r = await query(mcpUrl(), await agent(), "SELECT email FROM users");
    expect(r.structuredContent?.rows).toEqual([["alice@example.com"]]);
    const n = await query(mcpUrl(), await agent(), "SELECT body FROM notes");
    expect(n.isError).toBe(true);
    expect(n.content[0]?.text).toMatch(/notes/);

    // A database dropped from the bundle stops being served.
    const { version: v2 } = await cloud.publish({});
    await waitFor("the empty bundle", () => version() === v2);
    const gone = await query(mcpUrl(), await agent(), "SELECT 1");
    expect(gone.isError).toBe(true);

    const { version: v3 } = await cloud.publish({ main: READ_ALL });
    await waitFor("masks back on", () => version() === v3);
  });

  it("invariant 7: a rejected bundle changes nothing", async () => {
    const held = version() ?? 0;
    const masked = async () =>
      (await query(mcpUrl(), await agent(), "SELECT email FROM users"))
        .structuredContent?.rows;
    expect(await masked()).toEqual([["***"]]);
    const open = { main: { table_access: { default: "read_write" } } };
    const payload = (extra: Record<string, unknown>) => ({
      v: 1,
      iss: cloud.url,
      project_id: cloud.projectId,
      version: held + 1,
      iat: 0,
      paused: false,
      jwks: { keys: [] },
      databases: open,
      ...extra,
    });

    const { privateJwk: foreignKey } = await generateSigningKey();
    const good = await cloud.sign(payload({ databases: {} }));
    const [h, , s] = good.split(".");
    const forged = Buffer.from(JSON.stringify(payload({}))).toString(
      "base64url",
    );
    // Consecutive cases differ in what is reported, so each wait sees its own.
    const cases: [string, Promise<string>, number | null, RegExp][] = [
      [
        "foreign key",
        cloud.sign(payload({}), { privateJwk: foreignKey }),
        null,
        /signature/,
      ],
      [
        "other project",
        cloud.sign(payload({ project_id: "prj_other" })),
        held + 1,
        /another project/,
      ],
      ["older", cloud.sign(payload({ version: held - 1 })), held - 1, /older/],
      [
        "same version, other bytes",
        cloud.sign(payload({ version: held })),
        held,
        /different contents/,
      ],
      ["tampered", Promise.resolve(`${h}.${forged}.${s}`), null, /signature/],
    ];
    for (const [name, pending, v, reason] of cases) {
      cloud.deliver(await pending);
      await waitFor(`${name} reported`, () => {
        const r = cloud.statuses.at(-1)?.rejected;
        return r?.version === v && reason.test(r.reason);
      });
      expect(version(), name).toBe(held);
      expect(gw.gateway.enforcement.state, name).toBe("enforcing");
      expect(await masked(), name).toEqual([["***"]]);
    }
  });

  it("invariant 8: an unknown critical field halts; an unknown optional one is ignored", async () => {
    // Value: protects=only an enforceable bundle turns full text on; fails_when=apply() sets fullText only for enforce/paused, keeping the prior switch; why_new=no test sends full_text on a halting bundle; seam=none
    const { version: on } = await cloud.publish(
      { main: READ_ALL },
      { audit: { full_text: ["main"] } },
    );
    await waitFor("full statements on", () => version() === on);
    expect(gw.link?.sendsFullText("main")).toBe(true);
    // Nor does one whose token keys it can't use.
    const { version: badKeys } = await cloud.publish(
      { main: READ_ALL },
      {
        jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "AA", d: "AA" }] },
        audit: { full_text: ["main"] },
      },
    );
    await waitFor("the key halt", () => version() === badKeys);
    expect(gw.gateway.enforcement).toMatchObject({
      state: "halted",
      reason: expect.stringMatching(/token keys/),
    });
    expect(gw.link?.sendsFullText("main")).toBe(false);
    const { version: again } = await cloud.publish(
      { main: READ_ALL },
      { audit: { full_text: ["main"] } },
    );
    await waitFor("full statements on again", () => version() === again);
    expect(gw.link?.sendsFullText("main")).toBe(true);
    const { version: v } = await cloud.publish(
      { main: READ_ALL },
      {
        crit: ["row_filters"],
        row_filters: {},
        audit: { full_text: ["main"] },
      },
    );
    await waitFor("the halt", () => version() === v);
    expect(gw.gateway.enforcement.state).toBe("halted");
    // A bundle it can't enforce sends nothing as written, whatever it names.
    expect(gw.link?.sendsFullText("main")).toBe(false);
    const r = await query(mcpUrl(), await agent(), "SELECT 1");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/stopped enforcing.*row_filters/);
    expect((await fetch(`${gw.url}/readyz`)).status).toBe(503);
    await waitFor("the halt reported", () =>
      cloud.statuses.some((s) => s.state === "halted"),
    );

    const { version: v2 } = await cloud.publish(
      { main: { requires_features: ["tenant_scope"] } },
      {},
    );
    await waitFor("the feature halt", () => version() === v2);
    expect(gw.gateway.enforcement).toMatchObject({
      state: "halted",
      reason: expect.stringMatching(/tenant_scope/),
    });

    const { version: v3 } = await cloud.publish(
      { main: READ_ALL },
      { approvals_channel: { kind: "slack" } },
    );
    await waitFor("enforcing again", () => version() === v3);
    expect(gw.gateway.enforcement.state).toBe("enforcing");
    expect(
      (await query(mcpUrl(), await agent(), "SELECT 1")).isError,
    ).toBeFalsy();
  });

  it("pauses and resumes with the project", async () => {
    const { version: v } = await cloud.publish(
      { main: READ_ALL },
      { paused: true },
    );
    await waitFor("paused", () => version() === v);
    const r = await callTool(mcpUrl(), await agent(), "list_tables", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/paused/);
    const { version: v2 } = await cloud.publish({ main: READ_ALL });
    await waitFor("resumed", () => version() === v2);
    expect(
      (await callTool(mcpUrl(), await agent(), "list_tables", {})).isError,
    ).toBeFalsy();
  });

  it("refuses personal access tokens the bundle revokes", async () => {
    const kept = await agent({ jti: "pat-kept" });
    const revoked = await agent({ jti: "pat-revoked" });
    const { version: v } = await cloud.publish(
      { main: READ_ALL },
      { revoked_tokens: ["pat-revoked"] },
    );
    await waitFor("the revocation", () => version() === v);
    expect((await query(mcpUrl(), kept, "SELECT 1")).isError).toBeFalsy();
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${revoked}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("answers on the URLs its bundle registers, and only those", async () => {
    // As an operator adds a tunnel URL on the dashboard.
    const extra = `http://db.tunnel.localhost:${port}/mcp`;
    const ping = async (url: string, token: string) =>
      (
        await localFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        })
      ).status;
    const forExtra = await agent({ audience: extra });
    expect(await ping(mcpUrl(), forExtra)).toBe(401);
    expect(await ping(extra, await agent())).toBe(403);

    cloud.registered = [mcpUrl(), extra];
    const { version: v } = await cloud.publish({ main: READ_ALL });
    await waitFor("the extra URL", () => version() === v);
    expect(await ping(mcpUrl(), forExtra)).toBe(200);
    expect(await ping(extra, forExtra)).toBe(200);
    expect(await ping(extra, await agent())).toBe(200);
    const prm = (await (
      await localFetch(
        `http://db.tunnel.localhost:${port}/.well-known/oauth-protected-resource/mcp`,
      )
    ).json()) as { resource: string };
    expect(prm.resource).toBe(extra);

    // Removed again: its tokens and its host are refused.
    cloud.registered = [mcpUrl()];
    const { version: v2 } = await cloud.publish({ main: READ_ALL });
    await waitFor("the URL removed", () => version() === v2);
    expect(await ping(mcpUrl(), forExtra)).toBe(401);
    expect(await ping(extra, await agent())).toBe(403);
    expect(await ping(mcpUrl(), await agent())).toBe(200);
  });

  it("halts on a bundle that registers no URL for it", async () => {
    cloud.registered = [];
    const { version: v } = await cloud.publish({ main: READ_ALL });
    await waitFor("the halt", () => version() === v);
    expect(gw.gateway.enforcement).toMatchObject({
      state: "halted",
      reason: expect.stringMatching(/no URL for this gateway/),
    });
    cloud.registered = [mcpUrl()];
    const { version: v2 } = await cloud.publish({ main: READ_ALL });
    await waitFor("enforcing again", () => version() === v2);
    expect(gw.gateway.enforcement.state).toBe("enforcing");
  });

  it("keeps enforcing its cached bundle across a restart with the cloud down", async () => {
    const held = version();
    await gw.close();
    await cloud.down();
    gw = await start();
    expect(version()).toBe(held);
    expect(gw.gateway.enforcement.state).toBe("enforcing");
    const r = await query(mcpUrl(), await agent(), "SELECT email FROM users");
    expect(r.structuredContent?.rows).toEqual([["***"]]);
    await cloud.up();
  });

  it("takes from a sync only the version its freshness proof names", async () => {
    // An older authentic bundle, as a proxy that kept it could replay it.
    const { jws: old, version: va } = await cloud.publish({
      main: { table_access: { default: "read_write" } },
    });
    const { jws: latest, version: vb } = await cloud.publish({
      main: READ_ALL,
    });
    await waitFor("the latest", () => version() === vb);
    // Lost cache, cloud unreachable: nothing held, so only freshness stands
    // between the gateway and the replay.
    await gw.close();
    await cloud.down();
    rmSync(join(dir, "bundle.jws"));
    gw = await start();
    const link = gw.link;
    if (!link) throw new Error("no link");
    expect(await link.receive(old, { latest: vb })).toBe("rejected");
    expect(await link.receive(old, { latest: null })).toBe("rejected");
    expect(link.version).toBeNull();
    expect(await link.receive(latest, { latest: vb })).toBe("applied");
    expect(link.version).toBe(vb);
    expect(va).toBeLessThan(vb);
    await cloud.up();

    // Over the wire: the replay is refused, then the latest arrives.
    await gw.close();
    rmSync(join(dir, "bundle.jws"));
    const seen = cloud.statuses.length;
    cloud.deliver(old);
    gw = await start();
    await waitFor("the latest again", () => version() === vb);
    expect(
      cloud.statuses.slice(seen).some((s) => s.bundle_version === va),
    ).toBe(false);
  });

  it("refuses a bundle whose answer lost its freshness proof, then takes it with one", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      cloud.stripFreshness();
      const { version: v } = await cloud.publish({ main: READ_ALL });
      await waitFor("the bundle", () => version() === v);
      expect(lines.some((l) => l.includes('"msg":"bundle refused"'))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a command's result until the cloud has it", async () => {
    cloud.failResults(2);
    const id = cloud.command("test_connection");
    await waitFor("the result, third time", () => cloud.results.has(id));
    expect(cloud.results.get(id)).toMatchObject({ ok: true });
  });

  it("stays halted across a restart when its newest bundle can't be enforced", async () => {
    const { version: v } = await cloud.publish({ main: READ_ALL }, { v: 2 });
    await waitFor("the halt", () => version() === v);
    await gw.close();
    await cloud.down();
    gw = await start();
    expect(gw.gateway.enforcement.state).toBe("halted");
    // Its only bundle is the one it can't enforce, so it has no keys to
    // trust either: it refuses at the door, and says why only in its logs.
    expect(gw.gateway.enforcement).toMatchObject({
      reason: expect.stringMatching(/format 2/),
    });
    const res = await fetch(mcpUrl(), { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/format/);
    await cloud.up();
    const { version: v2 } = await cloud.publish({ main: READ_ALL });
    await waitFor("recovered", () => version() === v2);
  });

  it("serves nothing after a restart with the cloud down and no cached bundle", async () => {
    await gw.close();
    await cloud.down();
    rmSync(join(dir, "bundle.jws"));
    gw = await start();
    expect(gw.gateway.enforcement.state).toBe("waiting");
    expect((await fetch(mcpUrl(), { method: "POST" })).status).toBe(503);
    await cloud.up();
    await waitFor("a bundle again", () => version() !== null);
  });

  it("keeps enforcing when revocation cuts the link", async () => {
    const seen = cloud.statuses.length;
    cloud.revoke();
    await new Promise((r) => setTimeout(r, 500));
    expect(cloud.statuses.length).toBeLessThanOrEqual(seen + 1);
    expect(gw.gateway.enforcement.state).toBe("enforcing");
    expect(
      (await query(mcpUrl(), await agent(), "SELECT 1")).isError,
    ).toBeFalsy();
  });
});
