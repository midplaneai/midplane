import { describe, expect, it, vi } from "vitest";

import {
  ContainerRegistry,
  type SpawnedContainer,
  type Spawner,
  type SpawnOptions,
} from "../src/spawner.ts";

class StubSpawner implements Spawner {
  calls = 0;
  delayMs = 0;
  failNext = false;

  async spawn(_opts: SpawnOptions): Promise<SpawnedContainer> {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("spawn failed");
    }
    return {
      host: "127.0.0.1",
      port: 30000 + this.calls,
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }
}

const opts = (connectionId = "01HXYZCONN000000000000000A"): SpawnOptions => ({
  connectionId,
  region: "eu",
  databases: [
    {
      name: "main",
      connectionDatabaseId: "01HXYZMAIN0000000000000000",
      dsn: "postgres://x",
      tableAccess: { default: "deny", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
      guardrails: { block_unqualified_dml: true, block_ddl: true },
    },
  ],
});

describe("ContainerRegistry", () => {
  it("spawns once per connection, reuses on second acquire", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const a = await reg.acquire(opts());
    const b = await reg.acquire(opts());
    expect(stub.calls).toBe(1);
    expect(b.port).toBe(a.port);
  });

  it("dedupes concurrent first-spawns via inflight mutex", async () => {
    const stub = new StubSpawner();
    stub.delayMs = 30;
    const reg = new ContainerRegistry(stub);
    const [a, b, c] = await Promise.all([
      reg.acquire(opts()),
      reg.acquire(opts()),
      reg.acquire(opts()),
    ]);
    expect(stub.calls).toBe(1);
    expect(a.port).toBe(b.port);
    expect(b.port).toBe(c.port);
  });

  it("scopes registry per connection", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    await reg.acquire(opts("01HXYZCONN000000000000000A"));
    await reg.acquire(opts("01HXYZCONN000000000000000B"));
    expect(stub.calls).toBe(2);
    expect(reg.size()).toBe(2);
  });

  it("invalidate stops the container and forces respawn", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const first = await reg.acquire(opts());
    const stopSpy = first.stop as ReturnType<typeof vi.fn>;
    await reg.invalidate("01HXYZCONN000000000000000A");
    expect(stopSpy).toHaveBeenCalled();
    expect(reg.size()).toBe(0);
    await reg.acquire(opts());
    expect(stub.calls).toBe(2);
  });

  it("recovers when first spawn rejects (clears inflight slot)", async () => {
    const stub = new StubSpawner();
    stub.failNext = true;
    const reg = new ContainerRegistry(stub);
    await expect(reg.acquire(opts())).rejects.toThrow("spawn failed");
    // inflight cleared — next acquire actually retries.
    const ok = await reg.acquire(opts());
    expect(ok.port).toBe(30002);
    expect(stub.calls).toBe(2);
  });

  it("invalidate awaits an in-flight spawn and stops the resulting container", async () => {
    // Race: a request started acquire() (which is now mid-spawn with the
    // OLD DSN env) just before rotation. invalidate() must NOT return early
    // — if it does, the spawn lands in `entries` after rotation and the
    // container keeps serving the leaked DSN until idle expiry.
    const stub = new StubSpawner();
    stub.delayMs = 30;
    const reg = new ContainerRegistry(stub);
    const spawning = reg.acquire(opts());
    // Fire invalidate while spawn is still pending.
    const invalidating = reg.invalidate("01HXYZCONN000000000000000A");
    const spawned = await spawning;
    const stopSpy = spawned.stop as ReturnType<typeof vi.fn>;
    await invalidating;
    expect(stopSpy).toHaveBeenCalled();
    expect(reg.size()).toBe(0);
  });

  it("getActive returns ActiveContainer for live connections, null otherwise", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    expect(reg.getActive("01HXYZCONN000000000000000A")).toBeNull();

    const c = await reg.acquire(opts("01HXYZCONN000000000000000A"));
    const active = reg.getActive("01HXYZCONN000000000000000A");
    expect(active).not.toBeNull();
    expect(active?.host).toBe(c.host);
    expect(active?.port).toBe(c.port);
    expect(active?.region).toBe("eu");
    expect(active?.connectionId).toBe("01HXYZCONN000000000000000A");

    expect(reg.getActive("01HXYZCONN000000000000000B")).toBeNull();
  });

  it("getActive does NOT block on an in-flight spawn (returns null)", async () => {
    // Policy hot-reload shouldn't wait on a cold start; if there's no
    // entry yet, the saver returns the durable PG state and the next
    // request reads the new policy on its own.
    const stub = new StubSpawner();
    stub.delayMs = 50;
    const reg = new ContainerRegistry(stub);
    const spawning = reg.acquire(opts("01HXYZCONN000000000000000A"));
    expect(reg.getActive("01HXYZCONN000000000000000A")).toBeNull();
    await spawning;
    expect(reg.getActive("01HXYZCONN000000000000000A")).not.toBeNull();
  });

  it("idle timer triggers stop after idleMs", async () => {
    vi.useFakeTimers();
    try {
      const stub = new StubSpawner();
      const reg = new ContainerRegistry(stub, { idleMs: 1000 });
      const first = await reg.acquire(opts());
      const stopSpy = first.stop as ReturnType<typeof vi.fn>;
      vi.advanceTimersByTime(1100);
      // Timer fires invalidate(); allow microtasks to drain.
      await Promise.resolve();
      await Promise.resolve();
      expect(stopSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
