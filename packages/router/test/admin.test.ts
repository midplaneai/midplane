// Unit coverage for the cloud-side policy hot-reload helper.
//
// Each branch matches a status code the engine's POST /admin/policy can
// emit (or a network failure). Cloud's setTableAccess relies on the
// distinction — 400 must NOT trigger a respawn fallback, but 5xx/401
// must. Body shape is the multi-DB YAML; OSS 0.4.0 rejects the legacy
// single-section body on engines booted with a `databases:` block (which
// is every cloud-managed engine post-migration 0009).

import { describe, expect, it, vi } from "vitest";

import type { DatabaseEntry } from "@midplane-cloud/db";

import { pushPolicy, PushPolicyError } from "../src/admin.ts";
import {
  ContainerRegistry,
  type SpawnOptions,
  type Spawner,
  type SpawnedContainer,
} from "../src/spawner.ts";

class FakeSpawner implements Spawner {
  async spawn(_opts: SpawnOptions): Promise<SpawnedContainer> {
    return {
      host: "127.0.0.1",
      port: 31000,
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }
}

const databases: readonly DatabaseEntry[] = [
  {
    name: "main",
    connectionDatabaseId: "01HXYZMAIN0000000000000000",
    tableAccess: { default: "read", tables: { users: "deny" } },
    tenantScope: { column: null, overrides: {}, exempt: [] },
  },
];

const opts = (token = "tok-a"): SpawnOptions => ({
  token,
  region: "fra",
  databases: [
    {
      name: "main",
      connectionDatabaseId: "01HXYZMAIN0000000000000000",
      dsn: "postgres://x",
      tableAccess: { default: "deny", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
    },
  ],
});

async function makeRegWithActive(token = "tok-a"): Promise<ContainerRegistry> {
  const reg = new ContainerRegistry(new FakeSpawner());
  await reg.acquire(opts(token));
  return reg;
}

describe("pushPolicy", () => {
  it("returns delivered:false when no active container (no fetch)", async () => {
    const reg = new ContainerRegistry(new FakeSpawner());
    const fetchFn = vi.fn();
    const result = await pushPolicy("tok-missing", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    expect(result).toEqual({ delivered: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts YAML with bearer + content-type, returns delivered:true on 200", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
    const result = await pushPolicy("tok-a", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    expect(result).toEqual({ delivered: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("http://127.0.0.1:31000/admin/policy");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "text/yaml",
    );
    // Multi-DB YAML shape: top-level `databases:` block, with each DB
    // carrying its own `table_access:` and (if non-empty) `tenant_scope:`.
    // The legacy single-section body is rejected by 0.4.0+ on engines
    // booted with a `databases:` block — which is every cloud engine.
    const text = init.body as string;
    expect(text).toContain("databases:");
    expect(text).toContain("- name: main");
    expect(text).toContain("table_access:");
    expect(text).toContain("users: deny");
  });

  it("returns rejected with engine body on 400 (no throw)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(
      async () =>
        new Response("tables.users: must be one of deny, read, read_write", {
          status: 400,
        }),
    );
    const result = await pushPolicy("tok-a", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    expect(result).toEqual({
      rejected: {
        status: 400,
        body: "tables.users: must be one of deny, read, read_write",
      },
    });
  });

  it("treats 404 as delivered:false (engine route absent / dev)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
    const result = await pushPolicy("tok-a", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    expect(result).toEqual({ delivered: false });
  });

  it("throws PushPolicyError on 401 (caller falls back to invalidate)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(
      async () => new Response("bad bearer", { status: 401 }),
    );
    await expect(
      pushPolicy("tok-a", databases, {
        registry: reg,
        indexerToken: "wrong",
        fetch: fetchFn,
      }),
    ).rejects.toBeInstanceOf(PushPolicyError);
  });

  it("throws PushPolicyError on 500 (caller falls back to invalidate)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(
      async () => new Response("boom", { status: 500 }),
    );
    await expect(
      pushPolicy("tok-a", databases, {
        registry: reg,
        indexerToken: "secret",
        fetch: fetchFn,
      }),
    ).rejects.toBeInstanceOf(PushPolicyError);
  });

  it("throws underlying error on network failure (caller falls back)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      pushPolicy("tok-a", databases, {
        registry: reg,
        indexerToken: "secret",
        fetch: fetchFn,
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  // Per-token push mutex: closes the narrower race the FOR UPDATE lock
  // on the parent connection row doesn't cover. Two writers can commit
  // in order, then both reach the network and (because HTTP isn't
  // ordered) the older view can land last, leaving the engine on stale
  // state. The mutex chains pushes for the same token so the second
  // push doesn't start until the first one resolves.
  it("serializes two concurrent pushes for the same token (FIFO push order)", async () => {
    const reg = await makeRegWithActive("tok-serial");

    let inFlight = 0;
    let peakInFlight = 0;
    const order: number[] = [];
    let resolveFirst: (() => void) | null = null;
    const firstPending = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const fetchFn = vi.fn(async () => {
      const id = ++order.length; // 1 for first call, 2 for second
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (id === 1) {
          // Hold the first push until we release it. The second push
          // should be queued behind us, not racing on the wire.
          await firstPending;
        }
        return new Response("", { status: 200 });
      } finally {
        inFlight--;
      }
    });

    const p1 = pushPolicy("tok-serial", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    const p2 = pushPolicy("tok-serial", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });

    // Give the runtime a tick so p2 has a chance to start its fetch if
    // the mutex weren't in place — without serialization, peakInFlight
    // would jump to 2.
    await new Promise((r) => setTimeout(r, 10));
    expect(peakInFlight).toBe(1);

    resolveFirst!();
    await Promise.all([p1, p2]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(peakInFlight).toBe(1);
  });

  it("does not block pushes for different tokens (mutex is per-token)", async () => {
    const reg = await makeRegWithActive("tok-a");
    // Acquire a second container so /admin/policy resolves for tok-b too.
    await reg.acquire(opts("tok-b"));

    let aInFlight = 0;
    let bInFlight = 0;
    let peakConcurrent = 0;
    let resolveA: (() => void) | null = null;
    const aPending = new Promise<void>((r) => {
      resolveA = r;
    });

    const fetchFn = vi.fn(async (_url: string | URL | Request) => {
      // tok-a's container is on port 31000, tok-b is on 31001 (the fake
      // spawner increments per spawn — but our fake returns the same
      // host/port. Tag by which call this is instead.
      const isA = aInFlight === 0 && bInFlight === 0;
      if (isA) {
        aInFlight++;
      } else {
        bInFlight++;
      }
      const conc = aInFlight + bInFlight;
      peakConcurrent = Math.max(peakConcurrent, conc);
      try {
        if (isA) {
          await aPending;
        }
        return new Response("", { status: 200 });
      } finally {
        if (isA) aInFlight--;
        else bInFlight--;
      }
    });

    const pA = pushPolicy("tok-a", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    const pB = pushPolicy("tok-b", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });

    await new Promise((r) => setTimeout(r, 10));
    // tok-b shouldn't be blocked by tok-a — both pushes can be in
    // flight at the same time since the mutex keys on token.
    expect(peakConcurrent).toBe(2);

    resolveA!();
    await Promise.all([pA, pB]);
  });

  it("a failed first push does not poison the second (chain catches and continues)", async () => {
    const reg = await makeRegWithActive("tok-poison");

    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("ECONNREFUSED");
      return new Response("", { status: 200 });
    });

    const p1 = pushPolicy("tok-poison", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });
    const p2 = pushPolicy("tok-poison", databases, {
      registry: reg,
      indexerToken: "secret",
      fetch: fetchFn,
    });

    await expect(p1).rejects.toThrow("ECONNREFUSED");
    await expect(p2).resolves.toEqual({ delivered: true });
  });
});
