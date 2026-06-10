// dryRunPolicy — the verdict pipeline's ordering and error mapping.
//
// The load-bearing test is the FIRST one: acquire must come before
// pushPolicy. The fake registry returns no active container until
// acquire() has run — an implementation that gates on pushPolicy
// pre-acquire sees {delivered:false} and refuses every cold start
// (while passing against a warm dev engine). That exact bug shipped
// in plan form and was caught in review; this pins the fix.

import { describe, expect, it, vi } from "vitest";

import { dryRunPolicy, type DryRunRequest } from "../src/dry-run.ts";
import type { ContainerRegistry, SpawnOptions } from "../src/spawner.ts";

const SPAWN: SpawnOptions = {
  connectionId: "01HXYZCNN000000000000000AA",
  region: "eu",
  databases: [
    {
      name: "main",
      connectionDatabaseId: "01HXYZMAIN0000000000000000",
      dsn: "postgres://x",
      tableAccess: { default: "read", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
    },
  ],
};

const REQUEST: DryRunRequest = {
  database: "main",
  tenant_context: { value: "__midplane_probe__" },
  probes: [{ table: "orders", action: "select" }],
};

const VERDICTS = {
  verdicts: [
    {
      probe: { table: "orders", action: "select" },
      decision: "allow",
      reason: "default access: read",
      matched_rule: "default:read",
      tables: ["orders"],
      action: "select",
    },
  ],
  truncated: false,
};

/** Cold-start faithful fake: getActive() is null until acquire() runs —
 *  exactly the semantics that make pre-acquire pushPolicy gating a
 *  deadlock. */
function makeRegistry(opts: { failSpawn?: boolean } = {}) {
  let active: { host: string; port: number } | null = null;
  const registry = {
    async acquire(_spawn: SpawnOptions) {
      if (opts.failSpawn) throw new Error("fly capacity");
      active = { host: "127.0.0.1", port: 31000 };
      return active;
    },
    getActive(_id: string) {
      return active;
    },
  };
  return registry as unknown as ContainerRegistry;
}

function fetchScript(
  handlers: Array<(url: string) => Response | Promise<Response>>,
) {
  let i = 0;
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i += 1;
    return handler(u);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const okPolicy = () => new Response("ok", { status: 200 });
const okDryRun = () =>
  new Response(JSON.stringify(VERDICTS), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("dryRunPolicy", () => {
  it("orders acquire → pushPolicy → dry-run (cold engine succeeds)", async () => {
    const registry = makeRegistry();
    const { fn, calls } = fetchScript([okPolicy, okDryRun]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toEqual({ ok: true, response: VERDICTS });
    expect(calls[0]).toContain("/admin/policy");
    expect(calls[1]).toContain("/admin/dry-run");
    // Bearer on the dry-run call.
    const dryRunInit = (fn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1]![1] as RequestInit;
    expect(
      (dryRunInit.headers as Record<string, string>).authorization,
    ).toBe("Bearer t");
  });

  it("maps spawn failure to engine_unavailable", async () => {
    const registry = makeRegistry({ failSpawn: true });
    const { fn } = fetchScript([okPolicy]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({ ok: false, kind: "engine_unavailable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses on post-acquire delivery failure (admin/policy 404)", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([() => new Response("", { status: 404 })]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "policy delivery failed after spawn",
    });
  });

  it("surfaces a policy rejection verbatim", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      () => new Response("bad tenant column", { status: 400 }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toEqual({
      ok: false,
      kind: "engine_rejected",
      status: 400,
      body: "bad tenant column",
    });
  });

  it("maps dry-run 404 to engine_unavailable (image predates the endpoint)", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      () => new Response("not found", { status: 404 }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "engine image does not support dry-run yet",
    });
  });

  it("surfaces a dry-run 400 (malformed SQL) verbatim", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      () => new Response(`{"error":"unparseable sql"}`, { status: 400 }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toEqual({
      ok: false,
      kind: "engine_rejected",
      status: 400,
      body: `{"error":"unparseable sql"}`,
    });
  });

  it("treats a malformed 200 body as engine_unavailable", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "malformed dry-run response",
    });
  });

  it("maps a dry-run 401 (rotated/mismatched INDEXER_TOKEN) to engine_unavailable", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      () => new Response("unauthorized", { status: 401 }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "dry-run 401",
    });
  });

  it("treats a 200 with a non-JSON body as engine_unavailable (not a crash)", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      () => new Response("<html>gateway</html>", { status: 200 }),
    ]);
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({ ok: false, kind: "engine_unavailable" });
  });

  it("times out the engine call and reports it retryably", async () => {
    const registry = makeRegistry();
    let call = 0;
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        if (call === 1) return Promise.resolve(okPolicy());
        // Dry-run call: hang until aborted.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      },
    ) as unknown as typeof fetch;
    const result = await dryRunPolicy(SPAWN, REQUEST, {
      registry,
      indexerToken: "t",
      fetch: fn,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "engine timed out",
    });
  });
});
