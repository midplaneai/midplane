import { describe, expect, it, vi } from "vitest";

import { serializeMultiDbPolicyToYaml } from "@midplane-cloud/db";

import { OSS_ENGINE_IMAGE, OSS_ENGINE_IMAGE_GHCR } from "../src/oss-image.ts";
import {
  BOOT_FINGERPRINT_METADATA_KEY,
  FlyMachineSpawner,
  ghcrEngineRef,
  imageIsStale,
  isTransientCreateError,
  sameImageRef,
} from "../src/spawner-fly.ts";
import {
  bootFingerprint,
  toDatabaseEntry,
  type SpawnDatabase,
  type SpawnOptions,
} from "../src/spawner.ts";

const oneDb = [
  {
    name: "main",
    projectDatabaseId: "01HXYZMAIN0000000000000000",
    dsn: "postgres://x",
    tableAccess: { default: "read" as const, tables: {} },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
  },
];

const regions = {
  eu: { publicHost: "eu.midplane.ai", flyApp: "midplane-eu", flyRegion: "fra" },
  us: { publicHost: "us.midplane.ai", flyApp: "midplane-us", flyRegion: "iad" },
};

// Spawn once with the given spawner options and return the `config.image` that
// was posted to Fly — the single fact the image-resolution tests care about.
async function postedImageFor(
  overrides: Partial<ConstructorParameters<typeof FlyMachineSpawner>[0]>,
): Promise<string> {
  const ip = "fdaa:0:1::9";
  let postedImage = "";
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/machines") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      postedImage = (body.config as Record<string, unknown>).image as string;
      return new Response(
        JSON.stringify({ id: "m", private_ip: ip, state: "starting" }),
        { status: 200 },
      );
    }
    if (url.endsWith("/machines/m")) {
      return new Response(
        JSON.stringify({ id: "m", state: "started", private_ip: ip }),
        { status: 200 },
      );
    }
    if (url === `http://[${ip}]:8080/health`) {
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const spawner = new FlyMachineSpawner({
    apiToken: "fo-test",
    regions,
    bootTimeoutMs: 5000,
    fetch: fetchFn,
    ...overrides,
  });
  await spawner.spawn({
    projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
    region: "us",
    databases: oneDb,
  });
  return postedImage;
}

describe("FlyMachineSpawner", () => {
  it("posts machine create to the regional app and waits for started", async () => {
    let pollCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        const config = body.config as Record<string, unknown>;
        const env = config.env as Record<string, string>;
        // Multi-DB: DSN is injected as MIDPLANE_DSN_<projectDatabaseId>,
        // not DATABASE_URL. The YAML's `url:` references the env var via
        // ${...} interpolation per OSS 0.2.0 ENV_INTERP_RE.
        expect(env.MIDPLANE_DSN_01HXYZMAIN0000000000000000).toBe(
          "postgres://example",
        );
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.PORT).toBe("8080");
        // Dual-stack bind so the control plane can reach the engine over the
        // IPv6-only 6PN network (the engine's 0.0.0.0 default is IPv4-only).
        expect(env.MIDPLANE_HOST).toBe("::");
        expect(env.MIDPLANE_POLICY_FILE).toBe("/etc/midplane/policy.yaml");
        expect(body.region).toBe("fra");

        // Guest size is pinned explicitly — API-created machines don't
        // inherit fly-eu.toml's [[vm]], so without this the engine would
        // run at whatever Fly defaults to rather than a chosen size.
        expect(config.guest).toEqual({
          cpu_kind: "shared",
          cpus: 1,
          memory_mb: 256,
        });

        // No Fly volume mount: /data lives on the machine's rootfs so each
        // spawn gets a fresh filesystem. A volume here would either single-
        // attach-block the next concurrent spawn or leak the previous
        // customer's audit SQLite to the next one. Audit durability comes
        // from the indexer draining /audit/since into Postgres, not from
        // persisting the SQLite buffer across machine lifetimes.
        expect(config.mounts).toBeUndefined();

        // The policy YAML rides in config.files as base64. Decode and
        // confirm the exact bytes the engine will read at startup —
        // sorted keys, no quoting, terminating newline.
        const files = config.files as Array<{
          guest_path: string;
          raw_value: string;
        }>;
        expect(files).toHaveLength(1);
        expect(files[0]?.guest_path).toBe("/etc/midplane/policy.yaml");
        const decoded = Buffer.from(files[0]!.raw_value, "base64").toString(
          "utf8",
        );
        expect(decoded).toBe(
          [
            "databases:",
            "  - name: main",
            "    url: ${MIDPLANE_DSN_01HXYZMAIN0000000000000000}",
            "    table_access:",
            "      default: read",
            "      tables:",
            "        orders: read_write",
            "    guardrails:",
            "      block_unqualified_dml: true",
            "      block_ddl: true",
            "",
          ].join("\n"),
        );

        return new Response(
          JSON.stringify({
            id: "mach-1",
            private_ip: "fdaa:0:1234::5",
            state: "starting",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-1")) {
        pollCount += 1;
        const state = pollCount >= 2 ? "started" : "starting";
        return new Response(
          JSON.stringify({ id: "mach-1", state, private_ip: "fdaa:0:1234::5" }),
          { status: 200 },
        );
      }
      // Readiness gate: once the VM is started, spawn() polls the engine's
      // /health over 6PN before returning.
      if (url === "http://[fdaa:0:1234::5]:8080/health") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      fetch: fetchFn,
    });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://example",
          tableAccess: { default: "read", tables: { orders: "read_write" } },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
        },
      ],
    });

    expect(c.host).toBe("[fdaa:0:1234::5]");
    expect(c.port).toBe(8080);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("destroys the machine if it never reaches started", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify({ id: "mach-2", private_ip: "fdaa:0:5::1", state: "starting" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-2") && init?.method === "DELETE") {
        return new Response("", { status: 200 });
      }
      // Stay in starting forever to trigger timeout.
      return new Response(
        JSON.stringify({ id: "mach-2", state: "starting", private_ip: "fdaa:0:5::1" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 50,
      fetch: fetchFn,
    });

    await expect(
      spawner.spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "eu",
        databases: [
          {
            name: "main",
            projectDatabaseId: "01HXYZMAIN0000000000000000",
            dsn: "postgres://x",
            tableAccess: { default: "deny", tables: {} },
            tenantScope: { column: null, overrides: {}, exempt: [] },
            guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
          },
        ],
      }),
    ).rejects.toThrow(/did not start/);

    const destroyCall = calls.find((c) => c.startsWith("DELETE "));
    expect(destroyCall).toBeDefined();
  });

  it("destroys the machine if the VM starts but the engine never serves", async () => {
    // Regression for the readiness race: the Fly VM reaches `started` but the
    // OSS engine inside never binds :8080. spawn() must NOT hand back a dead
    // container — it must time out on /health and destroy the machine, so the
    // proxy reports a clean spawn failure instead of forwarding into a closed
    // port.
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify({ id: "mach-3", private_ip: "fdaa:0:9::9", state: "starting" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-3") && init?.method === "DELETE") {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/machines/mach-3")) {
        // VM is up right away...
        return new Response(
          JSON.stringify({ id: "mach-3", state: "started", private_ip: "fdaa:0:9::9" }),
          { status: 200 },
        );
      }
      if (url.endsWith(":8080/health")) {
        // ...but the engine never accepts projects.
        throw new Error("connect ECONNREFUSED");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 50,
      fetch: fetchFn,
    });

    await expect(
      spawner.spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "eu",
        databases: [
          {
            name: "main",
            projectDatabaseId: "01HXYZMAIN0000000000000000",
            dsn: "postgres://x",
            tableAccess: { default: "deny", tables: {} },
            tenantScope: { column: null, overrides: {}, exempt: [] },
            guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
          },
        ],
      }),
    ).rejects.toThrow(/did not become healthy/);

    expect(calls.some((c) => c.startsWith("DELETE "))).toBe(true);
  });

  it("adopts the existing machine on a create 409 instead of failing", async () => {
    // Registry is in-memory, so a web redeploy or a second web instance loses
    // the spawn entry and blind-creates → Fly 409 "already_exists". The
    // spawner must look the machine up by name, wake it if suspended, and
    // reuse it — NOT 502 and NOT destroy it (another instance may be using it).
    const spawnOpts: SpawnOptions = {
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://x",
          tableAccess: { default: "read", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: false, block_dml: false },
        },
      ],
    };
    const calls: string[] = [];
    let adoptedPolicyBody = "";
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify({
            error:
              'already_exists: unique machine name violation, machine ID mach-x already exists with name "mcp-01hxyzconnabcdef"',
          }),
          { status: 409 },
        );
      }
      if (method === "GET" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify([
            {
              id: "mach-x",
              name: "mcp-01hxyzconnabcdef",
              state: "suspended",
              private_ip: "fdaa:0:7::7",
              // Same image as the pin AND booted with the config this request
              // needs — adoption must NOT recreate.
              config: {
                image: OSS_ENGINE_IMAGE,
                metadata: { [BOOT_FINGERPRINT_METADATA_KEY]: bootFingerprint(spawnOpts) },
              },
            },
          ]),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/machines/mach-x/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/machines/mach-x")) {
        return new Response(
          JSON.stringify({ id: "mach-x", state: "started", private_ip: "fdaa:0:7::7" }),
          { status: 200 },
        );
      }
      if (url === "http://[fdaa:0:7::7]:8080/health") {
        return new Response("ok", { status: 200 });
      }
      if (url === "http://[fdaa:0:7::7]:8080/admin/policy" && method === "POST") {
        adoptedPolicyBody = String(init?.body ?? "");
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      indexerToken: "idx-tok",
      fetch: fetchFn,
    });

    const c = await spawner.spawn(spawnOpts);

    expect(c.host).toBe("[fdaa:0:7::7]");
    expect(c.port).toBe(8080);
    // It woke the suspended machine and never tore it down.
    expect(
      calls.some((s) => s === "POST https://api.machines.dev/v1/apps/midplane-eu/machines/mach-x/start"),
    ).toBe(true);
    expect(calls.some((s) => s.startsWith("DELETE "))).toBe(false);
    // An adopted machine keeps its creation-time policy FILE; the spawn
    // must hot-push the current policy so saves made while the registry
    // was cold (delivered:false) actually reach this persistent engine.
    expect(adoptedPolicyBody).toContain("block_ddl: false");
  });

  it("recreates an adopted machine whose image predates the pin (stale-engine skew)", () => {
    // A machine created under an older pin survives redeploys via name
    // adoption — and pre-0.9.0 engine schemas silently STRIP unknown
    // policy sections, so a stale engine acks the guardrails YAML while
    // enforcing none of it. Adoption must compare images and recreate.
    const calls: string[] = [];
    let createCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/machines")) {
        createCount += 1;
        if (createCount === 1) {
          // First create: name collision with the stale machine.
          return new Response(
            JSON.stringify({ error: "already_exists" }),
            { status: 409 },
          );
        }
        // Recreate after the stale machine was destroyed.
        return new Response(
          JSON.stringify({ id: "mach-new", private_ip: "fdaa:0:8::8", state: "starting" }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify([
            {
              id: "mach-stale",
              name: "mcp-01hxyzconnabcdef",
              state: "started",
              private_ip: "fdaa:0:7::7",
              config: { image: "midplane/midplane:0.8.0" },
            },
          ]),
          { status: 200 },
        );
      }
      if (method === "DELETE" && url.includes("/machines/mach-stale")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/machines/mach-new")) {
        return new Response(
          JSON.stringify({ id: "mach-new", state: "started", private_ip: "fdaa:0:8::8" }),
          { status: 200 },
        );
      }
      if (url === "http://[fdaa:0:8::8]:8080/health") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      fetch: fetchFn,
    });

    return spawner
      .spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "eu",
        databases: [
          {
            name: "main",
            projectDatabaseId: "01HXYZMAIN0000000000000000",
            dsn: "postgres://x",
            tableAccess: { default: "read", tables: {} },
            tenantScope: { column: null, overrides: {}, exempt: [] },
            guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
          },
        ],
      })
      .then((c) => {
        // The stale machine was destroyed and the project now runs
        // the pinned image.
        expect(
          calls.some((s) => s.startsWith("DELETE ") && s.includes("mach-stale")),
        ).toBe(true);
        expect(createCount).toBe(2);
        expect(c.host).toBe("[fdaa:0:8::8]");
      });
  });

  it("pulls the GHCR image when useGhcr is set (bypasses Fly's Docker Hub mirror)", async () => {
    // The whole point of the toggle: config.image must name the ghcr.io ref so
    // Fly pulls it directly instead of through docker-hub-mirror.fly.io.
    let postedImage = "";
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        postedImage = (body.config as Record<string, unknown>).image as string;
        return new Response(
          JSON.stringify({ id: "mach-g", private_ip: "fdaa:0:1::9", state: "starting" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-g")) {
        return new Response(
          JSON.stringify({ id: "mach-g", state: "started", private_ip: "fdaa:0:1::9" }),
          { status: 200 },
        );
      }
      if (url === "http://[fdaa:0:1::9]:8080/health") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      useGhcr: true,
      fetch: fetchFn,
    });

    await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "us",
      databases: oneDb,
    });

    expect(postedImage).toBe(OSS_ENGINE_IMAGE_GHCR);
    expect(postedImage.startsWith("ghcr.io/")).toBe(true);
  });

  it("GHCR toggle wins over a staged MIDPLANE_OSS_IMAGE=midplane/midplane (deploy-fly path)", async () => {
    // Regression: prod ALWAYS stages MIDPLANE_OSS_IMAGE=midplane/midplane:<tag>
    // (deploy-fly.yml:189). The toggle must still rewrite that to GHCR, or the
    // mirror bypass never takes effect in a normal rollout.
    expect(
      await postedImageFor({ image: "midplane/midplane:0.14.0", useGhcr: true }),
    ).toBe("ghcr.io/midplaneai/midplane:0.14.0");
  });

  it("GHCR toggle preserves the staged tag (not the compiled pin)", async () => {
    expect(
      await postedImageFor({ image: "midplane/midplane:0.15.0", useGhcr: true }),
    ).toBe("ghcr.io/midplaneai/midplane:0.15.0");
  });

  it("GHCR toggle carries a staged tag+digest across to GHCR", async () => {
    // deploy-fly.yml stages MIDPLANE_OSS_IMAGE=midplane/midplane:<tag>@sha256:<d>
    // so customer machines are byte-exact. The rewrite must keep the digest —
    // dropping it silently restores tag-granular pulls, and mangling the parse
    // returns null, which drops the machine back onto Fly's Docker Hub mirror.
    // Safe because engine-publish.yml pushes both registries from one build, so
    // the digest is identical in each (verified against the live 0.16.0 tag).
    expect(
      await postedImageFor({
        image: "midplane/midplane:0.16.0@sha256:abc",
        useGhcr: true,
      }),
    ).toBe("ghcr.io/midplaneai/midplane:0.16.0@sha256:abc");
  });

  it("without the toggle, a staged tag+digest is used as-is", async () => {
    expect(
      await postedImageFor({ image: "midplane/midplane:0.16.0@sha256:abc" }),
    ).toBe("midplane/midplane:0.16.0@sha256:abc");
  });

  it("GHCR toggle honors a genuinely custom image verbatim", async () => {
    // A fork / local dev tag is not our engine repo — respect the operator.
    expect(
      await postedImageFor({ image: "myfork/engine:dev", useGhcr: true }),
    ).toBe("myfork/engine:dev");
  });

  it("without the toggle, a staged image is used as-is", async () => {
    expect(
      await postedImageFor({ image: "midplane/midplane:0.14.0" }),
    ).toBe("midplane/midplane:0.14.0");
  });

  it("retries a transient create failure (registry mirror out of disk) then succeeds", async () => {
    // Reproduces the reported 502: Fly's Docker Hub mirror returns a registry
    // 500 ("no space left on device") wrapped as a 400 on create. A single
    // blip must not fail the whole spawn — retry and the next attempt wins.
    let createCalls = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        createCalls += 1;
        if (createCalls === 1) {
          return new Response(
            JSON.stringify({
              error:
                'failed to get manifest docker-hub-mirror.fly.io/midplane/midplane:0.14.0: request failed: unexpected http status code: Internal Server Error [http 500]: {"errors":[{"detail":"filesystem: mkdir /storage/docker/registry/...: no space left on device"}]}',
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ id: "mach-r", private_ip: "fdaa:0:2::2", state: "starting" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-r")) {
        return new Response(
          JSON.stringify({ id: "mach-r", state: "started", private_ip: "fdaa:0:2::2" }),
          { status: 200 },
        );
      }
      if (url === "http://[fdaa:0:2::2]:8080/health") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      fetch: fetchFn,
    });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "us",
      databases: oneDb,
    });

    expect(createCalls).toBe(2); // one failure + one retried success
    expect(c.host).toBe("[fdaa:0:2::2]");
  });

  it("gives up after createAttempts transient failures and throws", async () => {
    let createCalls = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        createCalls += 1;
        return new Response(
          JSON.stringify({ error: "boom: no space left on device" }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      createAttempts: 2,
      fetch: fetchFn,
    });

    await expect(
      spawner.spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "us",
        databases: oneDb,
      }),
    ).rejects.toThrow(/fly machine create failed/);
    expect(createCalls).toBe(2);
  });

  it("does NOT retry a permanent config error (fails fast)", async () => {
    let createCalls = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        createCalls += 1;
        return new Response(
          JSON.stringify({ error: "invalid machine config: guest memory_mb too low" }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      fetch: fetchFn,
    });

    await expect(
      spawner.spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "us",
        databases: oneDb,
      }),
    ).rejects.toThrow(/create failed: 400/);
    expect(createCalls).toBe(1); // permanent → no retry
  });

  it("throws if apiToken missing", () => {
    expect(
      () =>
        new FlyMachineSpawner({
          apiToken: "",
          regions,
        }),
    ).toThrow(/apiToken required/);
  });
});

// After a web redeploy the in-memory registry is empty but the project's engine
// machine is still running, so saves made in that window reach no engine
// (registry.invalidate has nothing to stop, pushPolicy has nothing to push to).
// The next spawn 409s and adopts by name: that adoption is the only point where
// the saved config can be enforced, so it must verify the machine booted with
// what this request needs and recreate it when it didn't.
describe("FlyMachineSpawner adoption after a web redeploy (cold registry)", () => {
  const PROJECT = "01HXYZCONNABCDEFGHIJKLMNOP";
  const MACHINE_NAME = "mcp-01hxyzconnabcdef";
  const OLD_IP = "fdaa:0:7::7";
  const NEW_IP = "fdaa:0:8::8";

  const baseDb: SpawnDatabase = {
    name: "main",
    projectDatabaseId: "01HXYZMAIN0000000000000000",
    dsn: "postgres://app:old-pass@db.example.com/app",
    tableAccess: { default: "read", tables: {} },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
  };

  const optsWith = (
    db: Partial<SpawnDatabase> = {},
    extra: Partial<SpawnOptions> = {},
  ): SpawnOptions => ({
    projectId: PROJECT,
    region: "eu",
    databases: [{ ...baseDb, ...db }],
    ...extra,
  });

  const APPROVALS_ON = {
    row_changes: true,
    whole_table_writes: true,
    schema_changes: true,
    expires_after_seconds: 1800,
    writes: true,
  };

  // Fly answers: the first create 409s (the machine is still there), the list
  // returns `existing`, and a recreate (if the spawner decides on one) succeeds.
  function harness(existingConfig: Record<string, unknown>, existingState = "started") {
    const calls: string[] = [];
    const createdConfigs: Array<Record<string, unknown>> = [];
    const pushedPolicies: string[] = [];
    let createCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/machines")) {
        createCount += 1;
        if (createCount === 1) {
          return new Response(JSON.stringify({ error: "already_exists" }), { status: 409 });
        }
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        createdConfigs.push(body.config as Record<string, unknown>);
        return new Response(
          JSON.stringify({ id: "mach-new", private_ip: NEW_IP, state: "starting" }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.endsWith("/machines")) {
        return new Response(
          JSON.stringify([
            {
              id: "mach-old",
              name: MACHINE_NAME,
              state: existingState,
              private_ip: OLD_IP,
              config: existingConfig,
            },
          ]),
          { status: 200 },
        );
      }
      if (method === "DELETE") return new Response("", { status: 200 });
      if (url.endsWith("/machines/mach-old")) {
        return new Response(
          JSON.stringify({ id: "mach-old", state: "started", private_ip: OLD_IP }),
          { status: 200 },
        );
      }
      if (url.endsWith("/machines/mach-new")) {
        return new Response(
          JSON.stringify({ id: "mach-new", state: "started", private_ip: NEW_IP }),
          { status: 200 },
        );
      }
      if (url.endsWith(":8080/health")) return new Response("ok", { status: 200 });
      if (method === "POST" && url.endsWith(":8080/admin/policy")) {
        pushedPolicies.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      indexerToken: "idx-tok",
      fetch: fetchFn,
    });
    return {
      spawner,
      createdConfigs,
      pushedPolicies,
      destroyedOld: () =>
        calls.some((c) => c.startsWith("DELETE ") && c.includes("/machines/mach-old")),
    };
  }

  // The config a machine created by an earlier spawn carries.
  const bootedWith = (opts: SpawnOptions) => ({
    image: OSS_ENGINE_IMAGE,
    metadata: { [BOOT_FINGERPRINT_METADATA_KEY]: bootFingerprint(opts) },
  });

  it("stamps the boot fingerprint into the machine metadata at create", async () => {
    const want = optsWith();
    const h = harness({ image: OSS_ENGINE_IMAGE }); // legacy machine → recreated
    await h.spawner.spawn(want);
    expect(h.createdConfigs).toHaveLength(1);
    expect(h.createdConfigs[0]!.metadata).toEqual({
      [BOOT_FINGERPRINT_METADATA_KEY]: bootFingerprint(want),
    });
  });

  it("(a) recreates the machine when column masks were added while the registry was cold", async () => {
    // The customer masks `email` after a redeploy. The running engine booted
    // without masks and can't hot-reload them, so adopting it would keep
    // returning plaintext emails while the dashboard says "masked".
    const before = optsWith();
    const after = optsWith(
      { columnMasks: { "public.users": { email: "full-redact" } } },
      { maskSalt: "salt-1" },
    );
    const h = harness(bootedWith(before));

    const c = await h.spawner.spawn(after);

    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
    const created = h.createdConfigs[0]!;
    expect((created.env as Record<string, string>).MIDPLANE_MASK_SALT).toBe("salt-1");
    const files = created.files as Array<{ raw_value: string }>;
    expect(Buffer.from(files[0]!.raw_value, "base64").toString("utf8")).toContain(
      "column_masks:",
    );
  });

  it("(b) adopts a matching machine and re-sends the FULL policy, approvals included", async () => {
    // Approvals are hot-reloadable, so turning them on must not force a
    // recreate. But the engine keeps its previous approvals when the block is
    // omitted, so the adopt-time push has to carry it, or writes keep running
    // unapproved while the UI says they're held.
    const before = optsWith();
    const after = optsWith({ approvals: APPROVALS_ON });
    expect(bootFingerprint(after)).toBe(bootFingerprint(before));
    const h = harness(bootedWith(before));

    const c = await h.spawner.spawn(after);

    expect(h.destroyedOld()).toBe(false);
    expect(c.host).toBe(`[${OLD_IP}]`);
    expect(h.pushedPolicies).toHaveLength(1);
    // Exactly what a fresh create would have booted from.
    expect(h.pushedPolicies[0]).toBe(
      serializeMultiDbPolicyToYaml(after.databases.map(toDatabaseEntry)),
    );
    expect(h.pushedPolicies[0]).toContain("approvals:");
    expect(h.pushedPolicies[0]).toContain("write_approvals");
  });

  it("(c) recreates the machine when the database password was rotated", async () => {
    // The DSN lives in the machine's env, set once at create. /admin/policy
    // only names the env var, so a push can't deliver the new password.
    const before = optsWith();
    const after = optsWith({ dsn: "postgres://app:new-pass@db.example.com/app" });
    const h = harness(bootedWith(before));

    const c = await h.spawner.spawn(after);

    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
    const env = h.createdConfigs[0]!.env as Record<string, string>;
    expect(env.MIDPLANE_DSN_01HXYZMAIN0000000000000000).toBe(
      "postgres://app:new-pass@db.example.com/app",
    );
  });

  it("recreates the machine when the approval gate env changed", async () => {
    const before = optsWith();
    const after = optsWith({}, { approvalGate: { url: "https://app/api/engine/approvals/x", token: "t" } });
    const h = harness(bootedWith(before));
    await h.spawner.spawn(after);
    expect(h.destroyedOld()).toBe(true);
  });

  it("recreates a machine created before fingerprinting (no metadata): its boot config is unknown", async () => {
    const h = harness({ image: OSS_ENGINE_IMAGE });
    const c = await h.spawner.spawn(optsWith());
    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
  });

  it("never adopts a machine stamped only under ANOTHER version's key (e.g. after a rollback)", async () => {
    // A release with a newer pre-image stamped this machine, then the web app
    // was rolled back. This instance can't verify that stamp, and adopting it
    // unverified would reopen the gap: recreate.
    const want = optsWith();
    const h = harness({
      image: OSS_ENGINE_IMAGE,
      metadata: { midplane_boot_fp_v999: bootFingerprint(want) },
    });
    const c = await h.spawner.spawn(want);
    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
  });

  it("recreates a FAILED machine even when its fingerprint matches (no stuck project)", async () => {
    // Adopting it would wait out the boot deadline into a 502, and since only a
    // machine we created is torn down on that failure, every later request
    // would adopt it again.
    const want = optsWith();
    const h = harness(bootedWith(want), "failed");
    const c = await h.spawner.spawn(want);
    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
  });

  it("adopts a masked project whose fingerprint matches and re-sends its masks unchanged", async () => {
    // The full re-send carries column_masks for a masked project. The engine
    // doesn't hot-swap masks, but it must accept the body, or every cold
    // adoption of a masked project would be destroyed as a rejected push.
    const want = optsWith(
      { columnMasks: { "public.users": { email: "full-redact" } } },
      { maskSalt: "salt-1" },
    );
    const h = harness(bootedWith(want));

    const c = await h.spawner.spawn(want);

    expect(h.destroyedOld()).toBe(false);
    expect(c.host).toBe(`[${OLD_IP}]`);
    expect(h.pushedPolicies).toEqual([
      serializeMultiDbPolicyToYaml(want.databases.map(toDatabaseEntry)),
    ]);
    expect(h.pushedPolicies[0]).toContain("column_masks:");
  });

  it("recreates a machine on an older image even when its boot fingerprint matches", async () => {
    // adoptable() has two independent reasons to refuse. A matching
    // fingerprint must not mask the stale-image one: a pre-0.9.0 engine
    // silently strips policy sections it doesn't know.
    const want = optsWith();
    const h = harness({
      image: "midplane/midplane:0.8.0",
      metadata: { [BOOT_FINGERPRINT_METADATA_KEY]: bootFingerprint(want) },
    });

    const c = await h.spawner.spawn(want);

    expect(h.destroyedOld()).toBe(true);
    expect(c.host).toBe(`[${NEW_IP}]`);
    expect(h.pushedPolicies).toHaveLength(0);
  });

  // The recreate loop after destroying an unadoptable machine: every create
  // 409s (the name is held), and each lookup returns the next entry in
  // `sightings` (the last one repeats). sightings[0] is the machine the spawner
  // finds and destroys; later entries are what another web instance recreated.
  const OTHER_IP = "fdaa:0:9::9";
  type Sighting = {
    id: string;
    state: string;
    private_ip: string;
    config: Record<string, unknown>;
  };
  function racedRecreate(sightings: Sighting[], onList?: (n: number) => void) {
    const calls: string[] = [];
    const pushedTo: string[] = [];
    let creates = 0;
    let lists = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && url.endsWith("/machines")) {
        creates += 1;
        return new Response(JSON.stringify({ error: "already_exists" }), { status: 409 });
      }
      if (method === "GET" && url.endsWith("/machines")) {
        lists += 1;
        onList?.(lists);
        const m = sightings[Math.min(lists - 1, sightings.length - 1)]!;
        return new Response(JSON.stringify([{ name: MACHINE_NAME, ...m }]), {
          status: 200,
        });
      }
      if (method === "DELETE") return new Response("", { status: 200 });
      if (method === "POST" && url.endsWith("/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const byId = sightings.find((m) => url.endsWith(`/machines/${m.id}`));
      if (byId) {
        return new Response(
          JSON.stringify({ id: byId.id, state: "started", private_ip: byId.private_ip }),
          { status: 200 },
        );
      }
      if (url.endsWith(":8080/health")) return new Response("ok", { status: 200 });
      if (method === "POST" && url.endsWith(":8080/admin/policy")) {
        pushedTo.push(url);
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      indexerToken: "idx-tok",
      fetch: fetchFn,
    });
    return {
      spawner,
      calls,
      pushedTo,
      creates: () => creates,
      lists: () => lists,
      deletes: () => calls.filter((c) => c.startsWith("DELETE ")),
    };
  }

  it("never adopts a machine another instance recreated with a DIFFERENT boot config; retries until the deadline", async () => {
    // Masks were added while the registry was cold. This spawn destroys the
    // unmasked engine, but another web instance still holding the pre-save
    // config wins the recreate race with another unmasked engine. Adopting it
    // would reintroduce exactly the bypass the fingerprint check exists to stop.
    const before = optsWith();
    const after = optsWith(
      { columnMasks: { "public.users": { email: "full-redact" } } },
      { maskSalt: "salt-1" },
    );
    // Jump past the 10s recreate deadline on the third lookup, so the loop
    // runs one real retry (a 500ms sleep) before giving up.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const h = racedRecreate(
        [
          { id: "mach-old", state: "started", private_ip: OLD_IP, config: bootedWith(before) },
          { id: "mach-other", state: "suspended", private_ip: OTHER_IP, config: bootedWith(before) },
        ],
        (n) => {
          if (n === 3) skew = 60_000;
        },
      );

      await expect(h.spawner.spawn(after)).rejects.toThrow(/could not be recreated/);

      // It looked again after the first unadoptable sighting, then gave up.
      expect(h.lists()).toBe(3);
      expect(h.creates()).toBe(3);
      // The racing machine was never woken, probed, pushed to, or destroyed.
      expect(h.calls.filter((c) => c.includes("mach-other") || c.includes(OTHER_IP))).toEqual(
        [],
      );
      expect(h.pushedTo).toEqual([]);
      expect(h.deletes()).toHaveLength(1);
      expect(h.deletes()[0]).toContain("/machines/mach-old");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("adopts the machine another instance recreated with the SAME boot config, waking and re-pushing it", async () => {
    // The password was rotated. Both instances see the new row, so the one
    // that wins the recreate race boots the same engine this spawn needs.
    const before = optsWith();
    const after = optsWith({ dsn: "postgres://app:new-pass@db.example.com/app" });
    const h = racedRecreate([
      { id: "mach-old", state: "started", private_ip: OLD_IP, config: bootedWith(before) },
      { id: "mach-other", state: "suspended", private_ip: OTHER_IP, config: bootedWith(after) },
    ]);

    const c = await h.spawner.spawn(after);

    expect(c.host).toBe(`[${OTHER_IP}]`);
    expect(h.creates()).toBe(2);
    expect(h.calls).toContain(
      "POST https://api.machines.dev/v1/apps/midplane-eu/machines/mach-other/start",
    );
    // Adopted, not created: it gets the adopt-time policy push.
    expect(h.pushedTo).toEqual([`http://[${OTHER_IP}]:8080/admin/policy`]);
    // Only the stale machine was destroyed; the adopted one is left alone.
    expect(h.deletes()).toHaveLength(1);
    expect(h.deletes()[0]).toContain("/machines/mach-old");
  });
});

describe("sameImageRef", () => {
  it("matches bare refs exactly", () => {
    expect(sameImageRef("midplane/midplane:0.9.0", "midplane/midplane:0.9.0")).toBe(true);
    expect(sameImageRef("midplane/midplane:0.8.0", "midplane/midplane:0.9.0")).toBe(false);
  });

  it("ignores registry-host prefixes Fly may normalize in", () => {
    // A raw string compare here would read every adoption as a mismatch —
    // destroying live machines after each web deploy.
    for (const host of ["docker.io", "registry-1.docker.io", "index.docker.io"]) {
      expect(
        sameImageRef(`${host}/midplane/midplane:0.9.0`, "midplane/midplane:0.9.0"),
      ).toBe(true);
    }
  });

  it("ignores digest suffixes but still catches tag mismatches", () => {
    expect(
      sameImageRef(
        "registry-1.docker.io/midplane/midplane:0.9.0@sha256:abc123",
        "midplane/midplane:0.9.0",
      ),
    ).toBe(true);
    expect(
      sameImageRef(
        "registry-1.docker.io/midplane/midplane:0.8.0@sha256:abc123",
        "midplane/midplane:0.9.0",
      ),
    ).toBe(false);
  });

  it("does not strip a plain org prefix (no dot/colon = not a registry host)", () => {
    expect(sameImageRef("midplane/midplane:0.9.0", "other/midplane:0.9.0")).toBe(false);
  });

  it("treats the Docker Hub and GHCR engine repos as the same artifact", () => {
    // engine-publish.yml pushes both from one build. During the GHCR rollout a
    // machine pulled from Docker Hub and a pin naming GHCR must compare EQUAL,
    // or adoption would recreate every machine on flag flip.
    expect(
      sameImageRef(OSS_ENGINE_IMAGE, OSS_ENGINE_IMAGE_GHCR),
    ).toBe(true);
    expect(
      sameImageRef("midplane/midplane:0.14.0", "ghcr.io/midplaneai/midplane:0.14.0"),
    ).toBe(true);
    // Different tags across sources still differ.
    expect(
      sameImageRef("midplane/midplane:0.14.0", "ghcr.io/midplaneai/midplane:0.13.0"),
    ).toBe(false);
    // A foreign repo on GHCR is NOT our engine.
    expect(
      sameImageRef("ghcr.io/midplaneai/midplane:0.14.0", "other/midplane:0.14.0"),
    ).toBe(false);
  });
});

describe("imageIsStale", () => {
  it("an older adopted tag is stale; an identical one is not", () => {
    expect(imageIsStale("midplane/midplane:0.8.0", "midplane/midplane:0.9.0")).toBe(true);
    expect(imageIsStale("midplane/midplane:0.9.0", "midplane/midplane:0.9.0")).toBe(false);
  });

  it("ONE-DIRECTIONAL: a NEWER adopted machine is never stale to an older pin", () => {
    // Mixed-pin bluegreen: the old web instance must not destroy the
    // machine the new instance just created — that ping-pong kills live
    // sessions on every flip.
    expect(imageIsStale("midplane/midplane:0.9.0", "midplane/midplane:0.8.0")).toBe(false);
    expect(imageIsStale("midplane/midplane:0.10.0", "midplane/midplane:0.9.0")).toBe(false);
  });

  it("non-semver or cross-repo differences trust the pin (stale)", () => {
    expect(imageIsStale("midplane/midplane:dev", "midplane/midplane:0.9.0")).toBe(true);
    expect(imageIsStale("other/midplane:0.9.0", "midplane/midplane:0.9.0")).toBe(true);
  });

  it("registry-host and digest normalization applies before comparing", () => {
    expect(
      imageIsStale(
        "registry-1.docker.io/midplane/midplane:0.9.0@sha256:abc",
        "midplane/midplane:0.9.0",
      ),
    ).toBe(false);
  });

  it("same-version Docker Hub and GHCR refs are never stale to each other (no rollout churn)", () => {
    // Neither direction recreates: a flag-flip during a bluegreen deploy leaves
    // mixed instances (one pins Docker Hub, one pins GHCR) — if either read the
    // other as stale they'd ping-pong the machine and kill live sessions.
    expect(
      imageIsStale("midplane/midplane:0.14.0", "ghcr.io/midplaneai/midplane:0.14.0"),
    ).toBe(false);
    expect(
      imageIsStale("ghcr.io/midplaneai/midplane:0.14.0", "midplane/midplane:0.14.0"),
    ).toBe(false);
  });

  it("still catches a genuinely older engine across sources", () => {
    // The stale-engine security guard must survive the aliasing: an old
    // Docker Hub machine vs a newer GHCR pin is still stale → recreate.
    expect(
      imageIsStale("midplane/midplane:0.8.0", "ghcr.io/midplaneai/midplane:0.14.0"),
    ).toBe(true);
  });
});

describe("isTransientCreateError", () => {
  it("treats the registry-out-of-disk 400 as transient (the reported 502 cause)", () => {
    expect(
      isTransientCreateError(
        400,
        'failed to get manifest docker-hub-mirror.fly.io/midplane/midplane:0.14.0: request failed: unexpected http status code: Internal Server Error [http 500]: no space left on device',
      ),
    ).toBe(true);
  });

  it("treats any 5xx as transient regardless of body", () => {
    expect(isTransientCreateError(500, "")).toBe(true);
    expect(isTransientCreateError(503, "service unavailable")).toBe(true);
  });

  it("does not retry a permanent config 400", () => {
    expect(
      isTransientCreateError(400, "invalid machine config: guest memory_mb too low"),
    ).toBe(false);
  });
});

describe("ghcrEngineRef", () => {
  it("rewrites the Docker Hub engine ref to GHCR at the same tag", () => {
    expect(ghcrEngineRef("midplane/midplane:0.14.0")).toBe(
      "ghcr.io/midplaneai/midplane:0.14.0",
    );
    expect(ghcrEngineRef("midplane/midplane:0.15.0")).toBe(
      "ghcr.io/midplaneai/midplane:0.15.0",
    );
  });

  it("strips a registry-host prefix before matching", () => {
    expect(ghcrEngineRef("registry-1.docker.io/midplane/midplane:0.14.0")).toBe(
      "ghcr.io/midplaneai/midplane:0.14.0",
    );
  });

  it("is idempotent on an already-GHCR ref", () => {
    expect(ghcrEngineRef("ghcr.io/midplaneai/midplane:0.14.0")).toBe(
      "ghcr.io/midplaneai/midplane:0.14.0",
    );
  });

  it("preserves a digest suffix", () => {
    expect(ghcrEngineRef("midplane/midplane@sha256:abc")).toBe(
      "ghcr.io/midplaneai/midplane@sha256:abc",
    );
  });

  it("preserves BOTH tag and digest (the shape deploy-fly.yml stages)", () => {
    // Regression: peeling the ":tag" split before the "@digest" split left
    // repo="midplane/midplane:0.16.0", which misses ENGINE_REPO_ALIASES, so this
    // returned null — the GHCR bypass silently switching itself off on exactly
    // the refs prod stages, sending cold spawns back through Fly's Docker Hub
    // mirror (the 502 source this whole path exists to avoid).
    expect(ghcrEngineRef("midplane/midplane:0.16.0@sha256:abc")).toBe(
      "ghcr.io/midplaneai/midplane:0.16.0@sha256:abc",
    );
    expect(
      ghcrEngineRef("registry-1.docker.io/midplane/midplane:0.16.0@sha256:abc"),
    ).toBe("ghcr.io/midplaneai/midplane:0.16.0@sha256:abc");
    expect(ghcrEngineRef("ghcr.io/midplaneai/midplane:0.16.0@sha256:abc")).toBe(
      "ghcr.io/midplaneai/midplane:0.16.0@sha256:abc",
    );
  });

  it("returns null for a non-engine image (honored verbatim)", () => {
    expect(ghcrEngineRef("myfork/engine:dev")).toBeNull();
    expect(ghcrEngineRef("other/midplane:0.14.0")).toBeNull();
    expect(ghcrEngineRef("other/midplane:0.16.0@sha256:abc")).toBeNull();
  });
});

describe("digest-qualified refs (deploy-fly.yml stages repo:tag@sha256:...)", () => {
  const PINNED = "midplane/midplane:0.16.0@sha256:abc";

  it("compares equal to the same version without a digest", () => {
    // Fly normalizes refs on the machine it reports back, and a machine created
    // before the digest-staging change carries the bare tag. Both must read as
    // the same image or adoption would destroy live machines on every check.
    expect(sameImageRef(PINNED, "midplane/midplane:0.16.0")).toBe(true);
    expect(sameImageRef(PINNED, "ghcr.io/midplaneai/midplane:0.16.0")).toBe(true);
  });

  it("does not read a bare-tag machine at the same version as stale", () => {
    expect(imageIsStale("midplane/midplane:0.16.0", PINNED)).toBe(false);
  });

  it("still reads an older version as stale", () => {
    expect(imageIsStale("midplane/midplane:0.15.0", PINNED)).toBe(true);
  });
});
