import { describe, expect, it, vi } from "vitest";

import { FlyMachineSpawner, imageIsStale, sameImageRef } from "../src/spawner-fly.ts";

const regions = {
  eu: { publicHost: "eu.midplane.ai", flyApp: "midplane-eu", flyRegion: "fra" },
  us: { publicHost: "us.midplane.ai", flyApp: "midplane-us", flyRegion: "iad" },
};

describe("FlyMachineSpawner", () => {
  it("posts machine create to the regional app and waits for started", async () => {
    let pollCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/machines") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        const config = body.config as Record<string, unknown>;
        const env = config.env as Record<string, string>;
        // Multi-DB: DSN is injected as MIDPLANE_DSN_<connectionDatabaseId>,
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
      connectionId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          connectionDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://example",
          tableAccess: { default: "read", tables: { orders: "read_write" } },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true },
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
        connectionId: "01HXYZCONNABCDEFGHIJKLMNOP",
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
        // ...but the engine never accepts connections.
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
        connectionId: "01HXYZCONNABCDEFGHIJKLMNOP",
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
      }),
    ).rejects.toThrow(/did not become healthy/);

    expect(calls.some((c) => c.startsWith("DELETE "))).toBe(true);
  });

  it("adopts the existing machine on a create 409 instead of failing", async () => {
    // Registry is in-memory, so a web redeploy or a second web instance loses
    // the spawn entry and blind-creates → Fly 409 "already_exists". The
    // spawner must look the machine up by name, wake it if suspended, and
    // reuse it — NOT 502 and NOT destroy it (another instance may be using it).
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
              // Same image as the pin — adoption must NOT recreate.
              config: { image: "midplane/midplane:0.9.0" },
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

    const c = await spawner.spawn({
      connectionId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          connectionDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://x",
          tableAccess: { default: "read", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: false },
        },
      ],
    });

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
        connectionId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "eu",
        databases: [
          {
            name: "main",
            connectionDatabaseId: "01HXYZMAIN0000000000000000",
            dsn: "postgres://x",
            tableAccess: { default: "read", tables: {} },
            tenantScope: { column: null, overrides: {}, exempt: [] },
            guardrails: { block_unqualified_dml: true, block_ddl: true },
          },
        ],
      })
      .then((c) => {
        // The stale machine was destroyed and the connection now runs
        // the pinned image.
        expect(
          calls.some((s) => s.startsWith("DELETE ") && s.includes("mach-stale")),
        ).toBe(true);
        expect(createCount).toBe(2);
        expect(c.host).toBe("[fdaa:0:8::8]");
      });
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
});
