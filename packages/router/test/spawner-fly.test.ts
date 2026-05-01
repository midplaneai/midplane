import { describe, expect, it, vi } from "vitest";

import { FlyMachineSpawner } from "../src/spawner-fly.ts";

const regions = {
  fra: { publicHost: "fra.midplane.com", flyApp: "midplane-fra" },
  iad: { publicHost: "iad.midplane.com", flyApp: "midplane-iad" },
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
        expect(env.MIDPLANE_POLICY_FILE).toBe("/etc/midplane/policy.yaml");
        expect(body.region).toBe("fra");

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
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const spawner = new FlyMachineSpawner({
      apiToken: "fo-test",
      regions,
      bootTimeoutMs: 5000,
      fetch: fetchFn,
    });

    const c = await spawner.spawn({
      token: "tok",
      region: "fra",
      databases: [
        {
          name: "main",
          connectionDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://example",
          tableAccess: { default: "read", tables: { orders: "read_write" } },
          tenantScopeMappings: {},
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
        token: "t",
        region: "fra",
        databases: [
          {
            name: "main",
            connectionDatabaseId: "01HXYZMAIN0000000000000000",
            dsn: "postgres://x",
            tableAccess: { default: "deny", tables: {} },
            tenantScopeMappings: {},
          },
        ],
      }),
    ).rejects.toThrow(/did not start/);

    const destroyCall = calls.find((c) => c.startsWith("DELETE "));
    expect(destroyCall).toBeDefined();
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
