import { describe, expect, it, vi } from "vitest";

import { FlyMachineSpawner } from "../src/spawner-fly.ts";

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
          },
        ],
      }),
    ).rejects.toThrow(/did not become healthy/);

    expect(calls.some((c) => c.startsWith("DELETE "))).toBe(true);
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
