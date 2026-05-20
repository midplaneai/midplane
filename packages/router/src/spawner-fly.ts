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
import type { RegionConfig } from "./region.ts";
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
    this.image = opts.image ?? process.env.MIDPLANE_OSS_IMAGE ?? "midplane/midplane:0.5.0";
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

    const created = await this.createMachine(app, regionCfg.flyRegion, opts);
    try {
      await this.waitForStarted(app, created.id);
    } catch (err) {
      await this.destroy(app, created.id).catch(() => undefined);
      throw err;
    }

    const fetchFn = this.fetchFn;
    const apiBase = this.apiBase;
    const token = this.token;
    return {
      // IPv6 literal must be bracketed for HTTP URLs.
      host: `[${created.private_ip}]`,
      port: 8080,
      async stop() {
        await destroyMachine(fetchFn, apiBase, token, app, created.id).catch(
          () => undefined,
        );
      },
    };
  }

  private async createMachine(
    app: string,
    flyRegion: string,
    opts: SpawnOptions,
  ): Promise<MachineCreateResponse> {
    // Per-DB DSN env vars. Names match OSS env-interpolation regex; the
    // YAML's `databases[].url` references each via ${...}. DSNs surface
    // here only — never in the YAML file content.
    const dsnEnv: Record<string, string> = {};
    for (const db of opts.databases) {
      dsnEnv[dsnEnvVarFor(db.connectionDatabaseId)] = db.dsn;
    }
    const policyYaml = serializeMultiDbPolicyToYaml(
      opts.databases.map((db) => ({
        name: db.name,
        connectionDatabaseId: db.connectionDatabaseId,
        tableAccess: db.tableAccess,
        tenantScope: db.tenantScope,
      })),
    );
    const res = await this.fetchFn(`${this.apiBase}/v1/apps/${app}/machines`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Machine name derived from the connection ULID, lowercased to
        // match Fly's naming rules. Stable for the connection's lifetime;
        // siblings tokens on the same connection share one machine. The
        // plaintext token never reaches the Fly API surface.
        name: `mcp-${opts.connectionId.slice(0, 16).toLowerCase()}`,
        region: flyRegion,
        config: {
          image: this.image,
          env: {
            ...dsnEnv,
            PORT: "8080",
            DB_PATH: "/data/audit.db",
            MIDPLANE_POLICY_FILE: POLICY_FILE_GUEST_PATH,
            ...(this.indexerToken
              ? { INDEXER_TOKEN: this.indexerToken }
              : {}),
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
      throw new Error(
        `fly machine create failed: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as MachineCreateResponse;
  }

  private async waitForStarted(app: string, id: string): Promise<void> {
    const deadline = Date.now() + this.bootTimeoutMs;
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

  private async destroy(app: string, id: string): Promise<void> {
    await destroyMachine(this.fetchFn, this.apiBase, this.token, app, id);
  }
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
