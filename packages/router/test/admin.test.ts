// Unit coverage for the cloud-side policy hot-reload helper.
//
// Each branch matches a status code the engine's POST /admin/policy can
// emit (or a network failure). Cloud's setTableAccess relies on the
// distinction — 400 must NOT trigger a respawn fallback, but 5xx/401
// must.

import { describe, expect, it, vi } from "vitest";

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

const policy = {
  default: "read",
  tables: { "public.users": "deny" },
} as const;

const opts = (token = "tok-a"): SpawnOptions => ({
  token,
  region: "fra",
  dsn: "postgres://x",
  tableAccess: { default: "deny", tables: {} },
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
    const result = await pushPolicy("tok-missing", policy, {
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
    const result = await pushPolicy("tok-a", policy, {
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
    expect(init.body as string).toContain("table_access:");
    expect(init.body as string).toContain("public.users: deny");
  });

  it("returns rejected with engine body on 400 (no throw)", async () => {
    const reg = await makeRegWithActive();
    const fetchFn = vi.fn(
      async () =>
        new Response("tables.users: must be one of deny, read, read_write", {
          status: 400,
        }),
    );
    const result = await pushPolicy("tok-a", policy, {
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
    const result = await pushPolicy("tok-a", policy, {
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
      pushPolicy("tok-a", policy, {
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
      pushPolicy("tok-a", policy, {
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
      pushPolicy("tok-a", policy, {
        registry: reg,
        indexerToken: "secret",
        fetch: fetchFn,
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
