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
      guardrails: { block_unqualified_dml: true, block_ddl: true },
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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

  it("runs a request sequence on ONE acquire+push, merging verdicts in order", async () => {
    // The guardrail path: probe matrix first, then each dangerous
    // statement as its own single-statement `sql` call. The engine sees
    // one /admin/policy push for the whole sequence; verdicts concatenate
    // in request order so the panel can zip them back positionally.
    const registry = makeRegistry();
    const guardrailVerdict = {
      verdicts: [
        {
          sql: "delete from orders",
          decision: "deny",
          reason: "Denied — DELETE without WHERE is blocked by guardrails.",
          matched_rule: "dangerous_statement",
          tables: ["orders"],
          action: "delete",
        },
      ],
      truncated: false,
    };
    const { fn, calls } = fetchScript([
      okPolicy,
      okDryRun,
      () =>
        new Response(JSON.stringify(guardrailVerdict), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await dryRunPolicy(
      SPAWN,
      [
        REQUEST,
        {
          database: "main",
          tenant_context: { value: "__midplane_probe__" },
          sql: "delete from orders",
        },
      ],
      { registry, indexerToken: "t", fetch: fn },
    );
    expect(calls.filter((c) => c.includes("/admin/policy"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/admin/dry-run"))).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.verdicts).toEqual([
        ...VERDICTS.verdicts,
        ...guardrailVerdict.verdicts,
      ]);
    }
  });

  it("fails the whole sequence when a later call errors (no partial verdicts)", async () => {
    const registry = makeRegistry();
    const { fn } = fetchScript([
      okPolicy,
      okDryRun,
      () => new Response("boom", { status: 500 }),
    ]);
    const result = await dryRunPolicy(
      SPAWN,
      [REQUEST, { database: "main", sql: "drop table orders" }],
      { registry, indexerToken: "t", fetch: fn },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "dry-run 500",
    });
  });

  it("refuses an empty request sequence before spawning anything", async () => {
    // A caller bug (route building zero requests) must not pay an engine
    // acquire + policy push just to discover there is nothing to ask.
    const registry = makeRegistry();
    const { fn, calls } = fetchScript([okPolicy, okDryRun]);
    const result = await dryRunPolicy(SPAWN, [], {
      registry,
      indexerToken: "t",
      fetch: fn,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "no dry-run requests",
    });
    expect(calls).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it("merges policy_hash (stable), truncated (OR), and total_tables across the sequence", async () => {
    // policy_hash must be IDENTICAL across one sequence's calls — the
    // engine's policy doesn't change between them (a differing hash is
    // the mid-run-swap failure pinned in the next test). truncated must
    // OR, not last-win: a truncated matrix followed by an untruncated
    // guardrail call still means the run was truncated.
    const registry = makeRegistry();
    const first = () =>
      new Response(
        JSON.stringify({
          ...VERDICTS,
          truncated: true,
          total_tables: 12,
          policy_hash: "sha256:stable",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const second = () =>
      new Response(
        JSON.stringify({
          verdicts: [
            {
              sql: "drop table orders",
              decision: "deny",
              reason: "Denied — DDL is blocked by guardrails.",
              matched_rule: "dangerous_statement",
              tables: ["orders"],
              action: "other",
            },
          ],
          truncated: false,
          policy_hash: "sha256:stable",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const { fn } = fetchScript([okPolicy, first, second]);
    const result = await dryRunPolicy(
      SPAWN,
      [REQUEST, { database: "main", sql: "drop table orders" }],
      { registry, indexerToken: "t", fetch: fn },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.policy_hash).toBe("sha256:stable");
      expect(result.response.truncated).toBe(true);
      expect(result.response.total_tables).toBe(12);
      expect(result.response.verdicts).toHaveLength(2);
    }
  });

  it("fails the run when policy_hash changes mid-sequence (hot-reload landed between calls)", async () => {
    // Verdicts from different policies must not merge into one coherent-
    // looking answer on the trust surface.
    const registry = makeRegistry();
    const withHash = (hash: string) => () =>
      new Response(JSON.stringify({ ...VERDICTS, policy_hash: hash }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { fn } = fetchScript([okPolicy, withHash("aaa"), withHash("bbb")]);
    const result = await dryRunPolicy(
      SPAWN,
      [REQUEST, { database: "main", sql: "drop table orders" }],
      { registry, indexerToken: "t", fetch: fn },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "policy changed mid-run",
    });
  });

  it("pushes deps.freshEntries (re-read post-acquire), not the spawn snapshot", async () => {
    // A cold spawn can take up to 60s; a save committed in that window
    // must not be overwritten on the live engine by the request-start
    // snapshot. The push body must reflect the re-read.
    const registry = makeRegistry();
    let pushedBody = "";
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/admin/policy")) {
        pushedBody = String(init?.body ?? "");
        return new Response("ok", { status: 200 });
      }
      return okDryRun();
    }) as unknown as typeof fetch;

    const result = await dryRunPolicy(SPAWN, [REQUEST], {
      registry,
      indexerToken: "t",
      fetch: fn,
      freshEntries: async () => [
        {
          name: "main",
          connectionDatabaseId: "01HXYZMAIN0000000000000000",
          tableAccess: { default: "read", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          // Differs from SPAWN's snapshot (both true) — the re-read wins.
          guardrails: { block_unqualified_dml: true, block_ddl: false },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(pushedBody).toContain("block_ddl: false");
  });

  it("maps a freshEntries failure to engine_unavailable (no stale push attempted)", async () => {
    const registry = makeRegistry();
    const { fn, calls } = fetchScript([okPolicy, okDryRun]);
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
      registry,
      indexerToken: "t",
      fetch: fn,
      freshEntries: async () => {
        throw new Error("connection disappeared during dry-run");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "engine_unavailable",
      detail: "connection disappeared during dry-run",
    });
    expect(calls.filter((c) => c.includes("/admin/policy"))).toHaveLength(0);
  });

  it("maps spawn failure to engine_unavailable", async () => {
    const registry = makeRegistry({ failSpawn: true });
    const { fn } = fetchScript([okPolicy]);
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
    const result = await dryRunPolicy(SPAWN, [REQUEST], {
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
