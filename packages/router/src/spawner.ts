// Spawner contract + in-memory ContainerRegistry.
//
// The router needs a process running the OSS image with the customer's
// decrypted DATABASE_URL injected. Two backends implement Spawner:
//
//   DockerSpawner       local `docker run` (dev / Playwright / no-Fly).
//   FlyMachineSpawner   Fly Machines API (production; needs FLY_API_TOKEN).
//
// The registry is the same in both cases: a per-token map of running
// containers, with a per-token mutex so concurrent first-requests don't
// double-spawn, and a 30-minute idle timer that triggers stop().
//
// Trust posture note: the DSN is NEVER logged or persisted. It is passed
// to the Spawner backend via env injection (Docker -e, Fly machine config)
// and held in process memory only as long as the container is alive.

import type { Region } from "@midplane-cloud/kms";

export interface SpawnedContainer {
  host: string;
  port: number;
  stop(): Promise<void>;
}

export interface SpawnOptions {
  token: string;
  region: Region;
  dsn: string;
}

export interface Spawner {
  spawn(opts: SpawnOptions): Promise<SpawnedContainer>;
}

interface RegistryEntry {
  container: SpawnedContainer;
  region: Region;
  idleTimer: ReturnType<typeof setTimeout>;
  lastTouchedAt: number;
}

export interface ActiveContainer {
  token: string;
  region: Region;
  host: string;
  port: number;
}

export interface ContainerRegistryOptions {
  /** Default 30 minutes. Idle stop window per design doc. */
  idleMs?: number;
  now?: () => number;
}

export class ContainerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly inflight = new Map<string, Promise<SpawnedContainer>>();
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly spawner: Spawner,
    opts: ContainerRegistryOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async acquire(opts: SpawnOptions): Promise<SpawnedContainer> {
    const existing = this.entries.get(opts.token);
    if (existing) {
      this.touch(opts.token, existing);
      return existing.container;
    }
    const pending = this.inflight.get(opts.token);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const container = await this.spawner.spawn(opts);
        const entry: RegistryEntry = {
          container,
          region: opts.region,
          idleTimer: this.scheduleStop(opts.token),
          lastTouchedAt: this.now(),
        };
        this.entries.set(opts.token, entry);
        return container;
      } finally {
        this.inflight.delete(opts.token);
      }
    })();
    this.inflight.set(opts.token, promise);
    return promise;
  }

  /** Snapshot of active containers — used by the audit indexer to know
   *  who to poll. Returned as a plain array so callers can iterate without
   *  holding a reference into the live map. */
  list(): ActiveContainer[] {
    const out: ActiveContainer[] = [];
    for (const [token, entry] of this.entries) {
      out.push({
        token,
        region: entry.region,
        host: entry.container.host,
        port: entry.container.port,
      });
    }
    return out;
  }

  async invalidate(token: string): Promise<void> {
    // A concurrent acquire() may have a spawn in flight when we're called
    // (typical during connection rotation: a request started just before
    // the customer paste-rotated). If we returned now without awaiting it,
    // the spawn would land in `entries` AFTER our invalidate and run with
    // the pre-rotation DSN until the next idle expiry. Wait for it to
    // settle (success or failure), then evict whatever ended up there.
    const pending = this.inflight.get(token);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const entry = this.entries.get(token);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.entries.delete(token);
    await entry.container.stop().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const tokens = [...this.entries.keys()];
    await Promise.all(tokens.map((t) => this.invalidate(t)));
  }

  size(): number {
    return this.entries.size;
  }

  private touch(token: string, entry: RegistryEntry): void {
    entry.lastTouchedAt = this.now();
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.scheduleStop(token);
  }

  private scheduleStop(token: string) {
    const timer = setTimeout(() => {
      void this.invalidate(token);
    }, this.idleMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    return timer;
  }
}
