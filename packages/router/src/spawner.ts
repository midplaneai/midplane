// Spawner contract + in-memory ContainerRegistry.
//
// The router needs a process running the OSS image with the customer's
// decrypted DATABASE_URL injected. Two backends implement Spawner:
//
//   DockerSpawner       local `docker run` (dev / Playwright / no-Fly).
//   FlyMachineSpawner   Fly Machines API (production; needs FLY_API_TOKEN).
//
// The registry is the same in both cases: a per-project map of running
// containers, with a per-project mutex so concurrent first-requests
// don't double-spawn, and a 30-minute idle timer that triggers stop().
//
// Keying note (PR2 of mcp_url_auth_security): the registry keys on the
// PROJECT id, not the plaintext token. The hybrid multi-token model
// shares one container across every sibling token on a project — the
// container's session-frozen X-Midplane-Token-Id (set by the proxy from
// the matched mcp_tokens row) is what discriminates audit attribution.
// Pre-PR2, the registry keyed on the plaintext token, which was a leak
// vector (process memory, container names, env-var names).
//
// Trust posture note: the DSN is NEVER logged or persisted. It is passed
// to the Spawner backend via env injection (Docker -e, Fly machine config)
// and held in process memory only as long as the container is alive.

import type {
  GuardrailsConfig,
  TableAccessPolicy,
  TenantScopeConfig,
} from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";

export interface SpawnedContainer {
  host: string;
  port: number;
  stop(): Promise<void>;
}

/** One DB the OSS container will be configured to reach. The spawner
 *  injects each DSN as an env var (MIDPLANE_DSN_<projectDatabaseId>)
 *  and writes a YAML `databases:` block referencing those env vars via
 *  ${...} interpolation — DSNs never touch disk. */
export interface SpawnDatabase {
  /** Agent-facing alias (`main`, `analytics`, …). */
  name: string;
  /** Stable id used to derive the DSN env var name. ULID-shaped so it
   *  matches OSS env-interpolation regex `[A-Z_][A-Z0-9_]*`. */
  projectDatabaseId: string;
  dsn: string;
  tableAccess: TableAccessPolicy;
  /** Strict-mode tenant_scope envelope (OSS 0.5.0). Inert configs
   *  (`column: null` + empty `overrides`) yield no tenant_scope block
   *  in the rendered YAML. */
  tenantScope: TenantScopeConfig;
  /** Dangerous-statement guardrails (OSS 0.9.0): no-WHERE DML + DDL
   *  blocks. Always emitted into the YAML, opt-outs included. */
  guardrails: GuardrailsConfig;
}

export interface SpawnOptions {
  /** Stable parent-project ULID. Used as the registry key, the
   *  container name suffix (lowercased), and (in production) the Fly
   *  machine name suffix. Token plaintext is NEVER passed to the
   *  spawner. */
  projectId: string;
  region: Region;
  /** One container per PROJECT, N>=1 DBs per container. The cloud
   *  always emits the multi-DB YAML shape, even for N=1; OSS 0.2.0
   *  treats a one-entry `databases:` array identically to the legacy
   *  single-DB shape, so the spawn path stays single-branched. */
  databases: readonly SpawnDatabase[];
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
  projectId: string;
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
    const key = opts.projectId;
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.container;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const container = await this.spawner.spawn(opts);
        const entry: RegistryEntry = {
          container,
          region: opts.region,
          idleTimer: this.scheduleStop(key),
          lastTouchedAt: this.now(),
        };
        this.entries.set(key, entry);
        return container;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Returns the live container for `projectId` if one is up, else
   *  `null`. Does NOT spawn and does NOT block on an in-flight spawn —
   *  used by cloud admin paths (policy hot-reload) that want to mutate
   *  a running engine without keeping it warm. A concurrent spawn that
   *  lands after this call is fine: the saver writes Postgres before
   *  calling here, so the new container's spawn-time read of
   *  `tableAccess` already picks up the change. */
  getActive(projectId: string): ActiveContainer | null {
    const entry = this.entries.get(projectId);
    if (!entry) return null;
    return {
      projectId,
      region: entry.region,
      host: entry.container.host,
      port: entry.container.port,
    };
  }

  /** Snapshot of active containers — used by the audit indexer to know
   *  which projects to poll. Returned as a plain array so callers
   *  can iterate without holding a reference into the live map. */
  list(): ActiveContainer[] {
    const out: ActiveContainer[] = [];
    for (const [projectId, entry] of this.entries) {
      out.push({
        projectId,
        region: entry.region,
        host: entry.container.host,
        port: entry.container.port,
      });
    }
    return out;
  }

  async invalidate(projectId: string): Promise<void> {
    // A concurrent acquire() may have a spawn in flight when we're called
    // (typical during project rotation: a request started just before
    // the customer paste-rotated). If we returned now without awaiting it,
    // the spawn would land in `entries` AFTER our invalidate and run with
    // the pre-rotation DSN until the next idle expiry. Wait for it to
    // settle (success or failure), then evict whatever ended up there.
    const pending = this.inflight.get(projectId);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const entry = this.entries.get(projectId);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.entries.delete(projectId);
    await entry.container.stop().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((k) => this.invalidate(k)));
  }

  size(): number {
    return this.entries.size;
  }

  private touch(key: string, entry: RegistryEntry): void {
    entry.lastTouchedAt = this.now();
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.scheduleStop(key);
  }

  private scheduleStop(key: string) {
    const timer = setTimeout(() => {
      void this.invalidate(key);
    }, this.idleMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    return timer;
  }
}
