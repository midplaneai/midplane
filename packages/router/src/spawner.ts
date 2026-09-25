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

import { createHash } from "node:crypto";

import type {
  ApprovalsConfig,
  ColumnMasksConfig,
  DatabaseEntry,
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
  /** Column masking (design A2): "schema.table" -> (column -> transform).
   *  Empty/absent yields no column_masks block in the rendered YAML. */
  columnMasks?: ColumnMasksConfig;
  /** Write approvals. Absent/off yields no approvals block AND no
   *  `write_approvals` feature token — which is why omitting this field is a
   *  FAIL-OPEN, not a no-op: the engine is told nothing and runs the write. */
  approvals?: ApprovalsConfig;
}

/** Map a SpawnDatabase to the policy DatabaseEntry the engine's boot YAML is
 *  rendered from — the single source of truth for the SPAWN mapping (previously
 *  duplicated verbatim in every spawner). The Fly adopt-time push re-sends this
 *  same mapping. The save-time hot-reload (admin.ts pushPolicy) builds its own
 *  entries without masking, which is boot-time-only.
 *
 *  ISSUE-007 launch: `maskSourceRewrite` is turned ON for every DB that declares
 *  masks, so the cloud emits `mask_source_rewrite: true` + the
 *  `requires_features: [mask_source_rewrite]` interlock and the engine masks at the
 *  SOURCE relation (aggregates over unmasked tables stop being blanket-denied)
 *  instead of the post-exec output filter. Inert on an unmasked DB — the serializer
 *  only emits the flag/token alongside a non-empty column_masks block — so setting it
 *  unconditionally is safe. Rollback: set this back to `false` and redeploy. The
 *  flag feeds bootFingerprint for masked DBs, so their engines are recreated on
 *  the next request and pick up the post-exec path; unmasked engines are left
 *  alone. */
export function toDatabaseEntry(db: SpawnDatabase): DatabaseEntry {
  return {
    name: db.name,
    projectDatabaseId: db.projectDatabaseId,
    tableAccess: db.tableAccess,
    tenantScope: db.tenantScope,
    guardrails: db.guardrails,
    columnMasks: db.columnMasks,
    maskSourceRewrite: true,
    approvals: db.approvals,
  };
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
  /** Per-engine secret keying the deterministic masking transforms, injected
   *  as MIDPLANE_MASK_SALT. Derived by the cloud per-project (W1). Required
   *  when any database declares column_masks — the engine refuses to boot
   *  with masks but no salt, so the proxy must supply it. Undefined when no
   *  database is masked. */
  maskSalt?: string;
  /** Write-approval gate for this project's engine. Both halves or neither —
   *  the engine refuses to boot half-configured, so passing one without the
   *  other is a spawn-time bug, not a runtime one.
   *
   *  Injected whenever the deployment has an approval secret, NOT only when a
   *  database currently has approvals on. The values are per-project constants,
   *  so wiring them unconditionally means enabling approvals is a pure policy
   *  hot-reload — a warm container already has the gate and just starts using
   *  it. Gating injection on the toggle would instead force a respawn, which
   *  drops the agent's live session the moment someone turns the feature on.
   *
   *  Undefined only when the deployment has no approval secret at all (self-host
   *  without it, or local dev), which keeps the container env byte-identical to
   *  today for everyone else. */
  approvalGate?: { url: string; token: string };
}

export interface Spawner {
  /** Must resolve to an engine that BOOTED with `opts`' boot-time config (see
   *  {@link bootFingerprint}): the registry records that fingerprint without
   *  checking. A backend that reuses an engine it didn't just start (Fly adopts
   *  by name) has to verify the engine's boot config first. */
  spawn(opts: SpawnOptions): Promise<SpawnedContainer>;
}

interface RegistryEntry {
  container: SpawnedContainer;
  region: Region;
  idleTimer: ReturnType<typeof setTimeout>;
  lastTouchedAt: number;
  /** Fingerprint of the BOOT-TIME-ONLY config this container was spawned with
   *  (see {@link bootFingerprint}). A warm container can't hot-reload it, so a
   *  later request with a different fingerprint must respawn, not reuse. */
  bootFingerprint: string;
}

/** Version of the {@link bootFingerprint} recipe. The Fly spawner stamps the
 *  fingerprint under a per-version metadata key and only trusts its own
 *  version's key, so a machine it can't verify is always recreated, never
 *  adopted.
 *
 *  Bump it when the recipe changes: an input added to or removed from the
 *  pre-image, or a new encoding. A new boot-only env var or YAML field counts,
 *  and must also be added to the pre-image, or machines booted without it would
 *  still be adopted. Every machine is then recreated once, and old instances in
 *  a bluegreen deploy recreate the new ones unless that release also stamps the
 *  previous version's key.
 *
 *  Do NOT bump for a changed value of an existing input (e.g. flipping
 *  toDatabaseEntry's maskSourceRewrite): the digest already changes for exactly
 *  the affected machines, and a bump would recreate every other one too. */
export const BOOT_FINGERPRINT_VERSION = 1;

// Fingerprint of the engine config a running engine CANNOT hot-reload. The
// engine reads all of it once at boot, so reusing an engine booted with a
// different fingerprint serves a wrong result:
//   - column_masks + mask_source_rewrite (per DB) and the mask salt: a possibly
//     UNMASKED result set (a masking bypass).
//   - each DB's DSN: injected as env at create. /admin/policy only names the env
//     var, so a rotated password can't be pushed and the engine keeps using the
//     old one. The DB id + name set rides along: adding a DB needs a new env var,
//     and the engine rejects a rename by hot-reload.
//   - the approval gate URL + token (env): a warm engine pointed at an old gate
//     401s every held write.
// table_access / tenant_scope / guardrails / approvals are deliberately
// EXCLUDED: those are pushed to a live engine via /admin/policy, and folding
// them in would respawn on every policy tweak.
//
// Returned as a sha256 hex digest. The pre-image holds DSNs, the salt and the
// gate token, and the Fly spawner stores the result in machine metadata, so only
// the digest may leave this function. Canonical (sorted keys and DBs): every web
// instance must compute the same value for the same config, or they would take
// turns recreating the same machine.
export function bootFingerprint(opts: SpawnOptions): string {
  const byId = (a: SpawnDatabase, b: SpawnDatabase) =>
    a.projectDatabaseId < b.projectDatabaseId ? -1 : a.projectDatabaseId > b.projectDatabaseId ? 1 : 0;
  const databases = [...opts.databases]
    .sort(byId)
    .map((d) => {
      const entry = toDatabaseEntry(d);
      const masks = entry.columnMasks ?? {};
      const masked = Object.values(masks).some((cols) => Object.keys(cols).length > 0);
      return {
        id: d.projectDatabaseId,
        name: d.name,
        dsn: d.dsn,
        columnMasks: masks,
        // Only where it does anything: the serializer emits the flag only next
        // to a non-empty column_masks block, so flipping it must not recreate
        // unmasked projects' engines.
        maskSourceRewrite: masked ? (entry.maskSourceRewrite ?? false) : null,
      };
    });
  const preimage = canonicalJson({
    salt: opts.maskSalt ?? "",
    gate: opts.approvalGate ?? null,
    databases,
  });
  return createHash("sha256").update(preimage).digest("hex");
}

// JSON with object keys sorted at every level, so two semantically equal
// configs serialize identically however their keys were ordered (mask rules are
// objects read back from jsonb).
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
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
  // The fingerprint rides with the in-flight promise so a concurrent request
  // with a DIFFERENT boot config doesn't get handed a spawn it didn't ask for.
  private readonly inflight = new Map<
    string,
    { promise: Promise<SpawnedContainer>; fingerprint: string }
  >();
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
    const fingerprint = bootFingerprint(opts);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.bootFingerprint === fingerprint) {
        this.touch(key, existing);
        return existing.container;
      }
      // Boot-time-only config (masks, salt, DSNs, gate) differs from how this
      // warm container booted — it can't hot-reload any of it, so reusing it
      // would serve a wrong (possibly UNMASKED) result set or a rotated-away
      // password. Evict + spawn fresh. This is the safety net behind the
      // save-time forceRespawn: it also catches a failed invalidate, a save or
      // rotation handled by another web instance, or a spawn path that booted a
      // mask-less container.
      await this.invalidate(key);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.fingerprint === fingerprint) return pending.promise;
      // A spawn with a DIFFERENT boot config is already in flight (e.g. a
      // mask-less dry-run spawn racing a masked proxy/preview request). Handing
      // it back would bypass the fingerprint guard, so wait for it to settle,
      // then re-acquire: the now-completed (mismatched) entry is evicted and
      // respawned with THIS request's config. Per-project container names are
      // unique, so two spawns can't run at once anyway — we have to serialize.
      await pending.promise.catch(() => undefined);
      return this.acquire(opts);
    }

    const promise = (async () => {
      try {
        // Recording `fingerprint` for this container is only truthful because
        // spawn() guarantees the engine booted with it — including an engine
        // the backend adopted rather than started (see Spawner.spawn).
        const container = await this.spawner.spawn(opts);
        const entry: RegistryEntry = {
          container,
          region: opts.region,
          idleTimer: this.scheduleStop(key),
          lastTouchedAt: this.now(),
          bootFingerprint: fingerprint,
        };
        this.entries.set(key, entry);
        return container;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { promise, fingerprint });
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
      await pending.promise.catch(() => undefined);
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
