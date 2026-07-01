// FlyMachineSpawner — production backend.
//
// One Fly machine per active token, scheduled in the regional app
// (midplane-eu / midplane-us) so the customer's data never leaves the
// region they picked at signup. Reachable via the machine's IPv6 6PN
// address; we proxy directly to the specific machine (not the app's
// anycast endpoint) so requests land on the same instance every time.
//
// The OSS transport already emits `fly-replay: cache_key=<session>`. Within
// Fly, that keeps subsequent requests stuck to the right machine even if
// the proxy fan-outs change. Across the Internet edge, we don't rely on
// fly-replay; we hold a per-token registry pointing at the specific 6PN IP.

import {
  dsnEnvVarFor,
  serializeMultiDbPolicyToYaml,
} from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";
import { OSS_ENGINE_IMAGE } from "./oss-image.ts";
import type { RegionConfig } from "./region.ts";
import { toDatabaseEntry } from "./spawner.ts";
import type { SpawnedContainer, Spawner, SpawnOptions } from "./spawner.ts";

// Path inside the OSS container where the policy YAML is materialized.
// The MIDPLANE_POLICY_FILE env var points the engine at this path.
const POLICY_FILE_GUEST_PATH = "/etc/midplane/policy.yaml";

export interface FlyMachineSpawnerOptions {
  apiToken: string;
  apiBase?: string;
  image?: string;
  regions: Record<Region, RegionConfig>;
  /** Default 60s — Fly cold start is slower than local Docker. */
  bootTimeoutMs?: number;
  /** Shared bearer the audit indexer presents to the container's
   *  GET /audit/since endpoint. Injected as INDEXER_TOKEN env on the
   *  Fly machine so OSS can compare. Required in production (the audit
   *  pipeline is non-optional on hosted) — caller should fail fast if
   *  unset. */
  indexerToken?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

interface MachineCreateResponse {
  id: string;
  private_ip: string;
  state: string;
}

interface MachineGetResponse {
  id: string;
  state: string;
  private_ip: string;
  /** Image the machine is actually running (from config.image on the
   *  list response). Undefined when Fly omits config — the adoption
   *  image check is skipped then (fail-open keeps the session alive;
   *  the realistic skew path always carries config). */
  image?: string;
}

export class FlyMachineSpawner implements Spawner {
  private readonly apiBase: string;
  private readonly image: string;
  private readonly token: string;
  private readonly indexerToken: string | undefined;
  private readonly regions: Record<Region, RegionConfig>;
  private readonly bootTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: FlyMachineSpawnerOptions) {
    if (!opts.apiToken) throw new Error("FlyMachineSpawner: apiToken required");
    this.token = opts.apiToken;
    this.indexerToken = opts.indexerToken;
    this.apiBase = opts.apiBase ?? "https://api.machines.dev";
    this.image = opts.image ?? process.env.MIDPLANE_OSS_IMAGE ?? OSS_ENGINE_IMAGE;
    this.regions = opts.regions;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 60_000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async spawn(opts: SpawnOptions): Promise<SpawnedContainer> {
    if (opts.databases.length === 0) {
      throw new Error("FlyMachineSpawner.spawn: at least one database required");
    }
    const regionCfg = this.regions[opts.region];
    if (!regionCfg) throw new Error(`unknown region: ${opts.region}`);
    const app = regionCfg.flyApp;
    const name = this.machineName(opts.projectId);

    // Create the machine, or ADOPT an existing one of the same name. The
    // machine name is the project's stable identity in Fly, but the
    // ContainerRegistry that decides spawn-vs-reuse is in-memory — a web-app
    // redeploy (bluegreen wipes the process) or a second web instance loses
    // that entry, so we'd blind-create and Fly would 409 "already_exists".
    // Adopting the live machine makes spawn idempotent against both.
    let machine = await this.createMachine(app, regionCfg.flyRegion, opts);
    let created = machine !== null;
    if (!machine) {
      const adopted = await this.getMachineByName(app, name);
      if (!adopted) {
        throw new Error(
          `fly machine ${name} reported existing on create but absent on lookup`,
        );
      }
      if (adopted.image !== undefined && imageIsStale(adopted.image, this.image)) {
        // Stale-image guard: a machine created under an older engine pin
        // survives web redeploys (it's adopted by name, never recreated).
        // That's not just version drift — pre-0.9.0 engine schemas are
        // non-strict and silently STRIP policy sections they don't know,
        // so a stale engine acks the new YAML while enforcing none of it
        // (the UI would claim guardrails are on; the engine wouldn't
        // know they exist). Recreate on mismatch so the pinned image is
        // what actually enforces. imageIsStale is ONE-DIRECTIONAL: an
        // instance never destroys a machine running a NEWER tag than its
        // own pin — during a bluegreen web deploy, mixed instances would
        // otherwise ping-pong the same engine machine, killing live
        // sessions on every flip.
        await this.destroy(app, adopted.id);
        // Fly's DELETE is async — the dying machine can hold the name for
        // a few seconds, so the create may keep 409ing. Retry briefly;
        // a concurrent spawn may also recreate it first, in which case we
        // adopt that one (if it's not stale too).
        const recreateDeadline = Date.now() + 10_000;
        for (;;) {
          machine = await this.createMachine(app, regionCfg.flyRegion, opts);
          if (machine) {
            created = true;
            break;
          }
          const recreated = await this.getMachineByName(app, name);
          if (
            recreated &&
            !(
              recreated.image !== undefined &&
              imageIsStale(recreated.image, this.image)
            ) &&
            recreated.id !== adopted.id
          ) {
            // Someone else recreated it on an acceptable image.
            machine = recreated;
            created = false;
            if (machine.state !== "started") {
              await this.startMachine(app, machine.id);
            }
            break;
          }
          if (Date.now() >= recreateDeadline) {
            throw new Error(
              `fly machine ${name} could not be recreated after destroying its stale image (want ${this.image})`,
            );
          }
          await sleep(500);
        }
      } else {
        machine = adopted;
        // Idle machines auto_stop=suspend. We reach the engine directly over
        // 6PN, which does NOT trip Fly's auto_start (that's edge-traffic only),
        // so an adopted-but-suspended machine must be woken before /health.
        if (machine.state !== "started") {
          await this.startMachine(app, machine.id);
        }
      }
    }

    // One boot budget spans both phases: the Fly VM reaching `started` AND
    // the OSS engine inside binding :8080. `started` only means the VM
    // booted — the engine needs a few more seconds to listen, and the proxy
    // forwards the MCP handshake the instant spawn() returns. Returning on
    // VM state alone races the engine: the first fetch hits a closed port,
    // the proxy tears the machine down (registry.invalidate), and every
    // retry cold-starts into the same race. DockerSpawner gates on /health
    // for exactly this reason; the Fly backend must too.
    const deadline = Date.now() + this.bootTimeoutMs;
    try {
      await this.waitForStarted(app, machine.id, deadline);
      await this.waitForHealth(machine.private_ip, deadline);
    } catch (err) {
      // Only tear down a machine WE created. An adopted machine may be live
      // for another instance/session — destroying it on a transient health
      // blip would kill a working engine. A genuinely broken adopted machine
      // idle-suspends and gets recreated on a later request.
      if (created) await this.destroy(app, machine.id).catch(() => undefined);
      throw err;
    }

    if (!created) {
      // Adopted machines keep the policy FILE they were created with, and
      // nothing else pushes after adoption: the hot-reload path resolves
      // engines via an in-memory registry that every web redeploy wipes,
      // so a config saved while the registry was cold reports
      // delivered:false ("next spawn reads from PG") — but this adoption
      // IS that next spawn, and without a push the persistent engine
      // keeps enforcing the old policy while PG and the UI say otherwise.
      // Push the spawn-time policy (read fresh from PG by the caller) so
      // adoption and creation leave the engine in the same state.
      try {
        await this.pushPolicyToMachine(machine.private_ip, opts);
      } catch (err) {
        // A machine that REFUSED the push would serve stale config
        // indefinitely — that's the silent-skew hazard, not a blip:
        // destroy it; the next request recreates with a fresh policy
        // file. A transient network failure is different — the machine
        // may be serving another instance's live session, so fail this
        // spawn WITHOUT destroying (the caller retries; teardown on a
        // blip would kill a working engine).
        if (!(err instanceof TransientPushError)) {
          await this.destroy(app, machine.id).catch(() => undefined);
        }
        throw err;
      }
    }

    const fetchFn = this.fetchFn;
    const apiBase = this.apiBase;
    const token = this.token;
    const machineId = machine.id;
    const privateIp = machine.private_ip;
    return {
      // IPv6 literal must be bracketed for HTTP URLs.
      host: `[${privateIp}]`,
      port: 8080,
      async stop() {
        await destroyMachine(fetchFn, apiBase, token, app, machineId).catch(
          () => undefined,
        );
      },
    };
  }

  // Stable per-project machine name. Fly enforces uniqueness on it, which
  // is exactly what lets a second web instance / a post-redeploy request find
  // the project's existing engine instead of double-spawning.
  private machineName(projectId: string): string {
    return `mcp-${projectId.slice(0, 16).toLowerCase()}`;
  }

  private async getMachineByName(
    app: string,
    name: string,
  ): Promise<MachineGetResponse | null> {
    const res = await this.fetchFn(`${this.apiBase}/v1/apps/${app}/machines`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(
        `fly machine list failed: ${res.status} ${await res.text()}`,
      );
    }
    const machines = (await res.json()) as Array<MachineGetResponse & {
      name?: string;
      config?: { image?: string };
    }>;
    const m = machines.find((x) => x.name === name);
    return m
      ? {
          id: m.id,
          state: m.state,
          private_ip: m.private_ip,
          image: m.config?.image,
        }
      : null;
  }

  // Wake a suspended/stopped machine. Best-effort: the real readiness gate is
  // waitForStarted + waitForHealth below, which fails cleanly if it never
  // comes up — so a non-2xx here (e.g. "already started") is not fatal.
  private async startMachine(app: string, id: string): Promise<void> {
    await this.fetchFn(
      `${this.apiBase}/v1/apps/${app}/machines/${id}/start`,
      { method: "POST", headers: { authorization: `Bearer ${this.token}` } },
    ).catch(() => undefined);
  }

  // Returns the created machine, or null when Fly reports the name is already
  // taken (409 already_exists) — the caller then adopts the live machine.
  private async createMachine(
    app: string,
    flyRegion: string,
    opts: SpawnOptions,
  ): Promise<MachineCreateResponse | null> {
    // Per-DB DSN env vars. Names match OSS env-interpolation regex; the
    // YAML's `databases[].url` references each via ${...}. DSNs surface
    // here only — never in the YAML file content.
    const dsnEnv: Record<string, string> = {};
    for (const db of opts.databases) {
      dsnEnv[dsnEnvVarFor(db.projectDatabaseId)] = db.dsn;
    }
    const policyYaml = serializeMultiDbPolicyToYaml(
      opts.databases.map(toDatabaseEntry),
    );
    const res = await this.fetchFn(`${this.apiBase}/v1/apps/${app}/machines`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Machine name derived from the project ULID, lowercased to
        // match Fly's naming rules. Stable for the project's lifetime;
        // sibling tokens on the same project share one machine, and a
        // post-redeploy request adopts it by this name. The plaintext token
        // never reaches the Fly API surface.
        name: this.machineName(opts.projectId),
        region: flyRegion,
        config: {
          image: this.image,
          // Pin the VM size explicitly. Machines created through the Machines
          // API do NOT inherit fly-eu.toml's [[vm]] block — that only governs
          // `fly deploy`. Without this the engine silently falls to the API
          // default (shared-cpu-1x / 256 MB), so the size is whatever Fly
          // happens to default to rather than a decision. 256 MB / 1 shared
          // CPU is the floor and fits the proxy plus its SQLite audit buffer.
          // If the engine starts OOM-killing under load, bump here AND in
          // fly-eu.toml together.
          guest: {
            cpu_kind: "shared",
            cpus: 1,
            memory_mb: 256,
          },
          env: {
            ...dsnEnv,
            PORT: "8080",
            // Bind the engine's HTTP server to :: (dual-stack) so the control
            // plane can reach it over Fly's IPv6-only 6PN network at
            // [private_ip]:8080. The engine's default bind is 0.0.0.0 (IPv4),
            // which is unreachable over 6PN — every waitForHealth probe fails
            // and the spawn 502s. Honored by engine images that read
            // MIDPLANE_HOST (>= 0.7.1); older images ignore the unknown var, so
            // this is safe to ship ahead of the image republish + pin bump
            // (inert until then).
            MIDPLANE_HOST: "::",
            DB_PATH: "/data/audit.db",
            MIDPLANE_POLICY_FILE: POLICY_FILE_GUEST_PATH,
            ...(this.indexerToken
              ? { INDEXER_TOKEN: this.indexerToken }
              : {}),
            // Masking salt; present only when a database declares column_masks
            // (the engine refuses to boot with masks but no salt).
            ...(opts.maskSalt ? { MIDPLANE_MASK_SALT: opts.maskSalt } : {}),
          },
          // Inline file content per machine. The Fly Machines API base64-
          // decodes raw_value into the guest filesystem at start. No volume,
          // no image rebuild — the file lives only as long as the machine
          // does. Policy changes happen via registry.invalidate(token) +
          // respawn, so the new YAML appears with the next agent request.
          files: [
            {
              guest_path: POLICY_FILE_GUEST_PATH,
              raw_value: btoa(policyYaml),
            },
          ],
          services: [
            {
              ports: [{ port: 8080, handlers: ["http"] }],
              protocol: "tcp",
              internal_port: 8080,
            },
          ],
          checks: {
            health: {
              type: "http",
              port: 8080,
              path: "/health",
              interval: "30s",
              timeout: "5s",
              grace_period: "10s",
            },
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      // Name collision: a machine for this project already exists (our
      // in-memory registry was lost to a redeploy, or another web instance
      // owns it). Signal the caller to adopt it rather than failing the spawn.
      if (res.status === 409 || text.includes("already_exists")) return null;
      throw new Error(`fly machine create failed: ${res.status} ${text}`);
    }
    return (await res.json()) as MachineCreateResponse;
  }

  private async waitForStarted(
    app: string,
    id: string,
    deadline: number,
  ): Promise<void> {
    while (Date.now() < deadline) {
      const res = await this.fetchFn(
        `${this.apiBase}/v1/apps/${app}/machines/${id}`,
        { headers: { authorization: `Bearer ${this.token}` } },
      );
      if (res.ok) {
        const body = (await res.json()) as MachineGetResponse;
        if (body.state === "started") return;
        if (body.state === "failed" || body.state === "destroyed") {
          throw new Error(`machine entered terminal state: ${body.state}`);
        }
      }
      await sleep(500);
    }
    throw new Error(
      `fly machine did not start within ${this.bootTimeoutMs}ms`,
    );
  }

  // After the VM reports `started`, poll the engine's own /health over 6PN
  // until it answers 2xx, so spawn() only hands back a container that's
  // actually serving. The control plane reaches the machine by its private
  // IPv6 (bracketed for the URL). Mirrors DockerSpawner.waitForHealth; shares
  // the caller's boot deadline so total boot time stays bounded by
  // bootTimeoutMs rather than doubling across the two phases.
  private async waitForHealth(
    privateIp: string,
    deadline: number,
  ): Promise<void> {
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchFn(`http://[${privateIp}]:8080/health`);
        if (res.ok) return;
        lastErr = new Error(`health returned ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(500);
    }
    throw new Error(
      `OSS engine did not become healthy within ${this.bootTimeoutMs}ms: ${String(lastErr)}`,
    );
  }

  // Hot-swap the policy on an adopted machine via the engine's
  // POST /admin/policy (same body shape pushPolicy in admin.ts sends).
  // Skipped without an indexerToken — the engine's admin surface is 404
  // in that mode (laptop dev); hosted always has the token.
  private async pushPolicyToMachine(
    privateIp: string,
    opts: SpawnOptions,
  ): Promise<void> {
    if (!this.indexerToken) return;
    const body = serializeMultiDbPolicyToYaml(
      opts.databases.map((db) => ({
        name: db.name,
        projectDatabaseId: db.projectDatabaseId,
        tableAccess: db.tableAccess,
        tenantScope: db.tenantScope,
        guardrails: db.guardrails,
      })),
    );
    let res: Response;
    try {
      res = await this.fetchFn(`http://[${privateIp}]:8080/admin/policy`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.indexerToken}`,
          "content-type": "text/yaml",
        },
        body,
      });
    } catch (err) {
      // Network-level failure — the caller must NOT destroy on this.
      throw new TransientPushError(
        `adopted machine policy push failed (network): ${String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `adopted machine rejected policy push: ${res.status} ${await res
          .text()
          .catch(() => "")}`,
      );
    }
  }

  private async destroy(app: string, id: string): Promise<void> {
    await destroyMachine(this.fetchFn, this.apiBase, this.token, app, id);
  }
}

/** Thrown when the adoption policy push failed at the NETWORK level —
 *  the machine may be healthy and serving another instance's session,
 *  so the spawn fails without tearing it down. */
export class TransientPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientPushError";
  }
}

/** Compare image refs by repo:tag, ignoring registry-host prefixes and
 *  digest suffixes Fly may normalize in (`registry-1.docker.io/...`,
 *  `...@sha256:`). A raw string compare would read every adoption as a
 *  mismatch the moment Fly normalizes — destroying live machines on each
 *  registry-cache miss and throwing on the re-adopt path. Exported for
 *  tests. */
export function sameImageRef(a: string, b: string): boolean {
  return normalizeImageRef(a) === normalizeImageRef(b);
}

function normalizeImageRef(ref: string): string {
  let r = ref.split("@")[0]!; // drop digest
  // Drop a registry-host prefix (contains "." or ":" before the first
  // slash — `docker.io/`, `registry-1.docker.io/`, `localhost:5000/`).
  const firstSlash = r.indexOf("/");
  if (firstSlash > 0) {
    const head = r.slice(0, firstSlash);
    if (head.includes(".") || head.includes(":")) r = r.slice(firstSlash + 1);
  }
  return r;
}

/** ONE-DIRECTIONAL staleness: true only when `adopted` should be torn
 *  down in favor of `pinned`. When both tags parse as semver, only an
 *  OLDER adopted machine is stale — an instance still on last release's
 *  pin must never destroy a machine a newer instance just created, or a
 *  mixed-pin bluegreen deploy ping-pongs the same engine machine (each
 *  flip killing live MCP sessions). Non-semver differences fall back to
 *  trusting the pin (recreate). Exported for tests. */
export function imageIsStale(adoptedRef: string, pinnedRef: string): boolean {
  if (sameImageRef(adoptedRef, pinnedRef)) return false;
  const adopted = parseTagSemver(adoptedRef);
  const pinned = parseTagSemver(pinnedRef);
  if (adopted && pinned) {
    for (let i = 0; i < 3; i++) {
      if (adopted[i]! < pinned[i]!) return true;
      if (adopted[i]! > pinned[i]!) return false;
    }
    // Same numeric version but refs differ (different repo/name) — not
    // an age question; trust the pin and recreate.
    return true;
  }
  return true;
}

function parseTagSemver(ref: string): [number, number, number] | null {
  const tag = normalizeImageRef(ref).split(":")[1];
  if (!tag) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function destroyMachine(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  app: string,
  id: string,
): Promise<void> {
  await fetchFn(`${apiBase}/v1/apps/${app}/machines/${id}?force=true`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
