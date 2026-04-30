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

const opts = (token = "tok-a"): SpawnOptions => ({
  token,
  region: "fra",
  dsn: "postgres://x",
});

describe("ContainerRegistry", () => {
  it("spawns once per token, reuses on second acquire", async () => {
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

  it("scopes registry per token", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    await reg.acquire(opts("tok-a"));
    await reg.acquire(opts("tok-b"));
    expect(stub.calls).toBe(2);
    expect(reg.size()).toBe(2);
  });

  it("invalidate stops the container and forces respawn", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const first = await reg.acquire(opts());
    const stopSpy = first.stop as ReturnType<typeof vi.fn>;
    await reg.invalidate("tok-a");
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
