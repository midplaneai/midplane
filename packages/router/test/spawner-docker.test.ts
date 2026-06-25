import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { OSS_ENGINE_IMAGE } from "../src/oss-image.ts";
import { DockerSpawner, parseHostPort } from "../src/spawner-docker.ts";

describe("parseHostPort", () => {
  it("parses IPv4 mapping", () => {
    expect(parseHostPort("0.0.0.0:32768\n[::]:32768\n")).toBe(32768);
  });

  it("parses single line", () => {
    expect(parseHostPort("0.0.0.0:54321")).toBe(54321);
  });

  it("throws on garbage", () => {
    expect(() => parseHostPort("nope")).toThrow();
  });
});

describe("DockerSpawner", () => {
  it("runs container, reads port, polls /health, returns stop()", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === "run") return { stdout: "container_abc123\n" };
      if (args[0] === "port") return { stdout: "0.0.0.0:33001\n" };
      if (args[0] === "stop" || args[0] === "rm") return { stdout: "" };
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    });
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    const spawner = new DockerSpawner({
      image: OSS_ENGINE_IMAGE,
      exec,
      fetch: fetchFn,
      bootTimeoutMs: 1000,
    });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://example",
          tableAccess: { default: "read", tables: { users: "deny" } },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true },
        },
      ],
    });

    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(33001);
    expect(exec).toHaveBeenCalled();

    const runArgs = exec.mock.calls.find((c) => c[1]?.[0] === "run")?.[1] ?? [];
    expect(runArgs).toContain(OSS_ENGINE_IMAGE);
    // Multi-DB: DSN is injected as a per-DB env var (MIDPLANE_DSN_<id>),
    // never as a top-level DATABASE_URL — the YAML's `url:` references
    // the env via ${...} interpolation.
    expect(runArgs).toContain(
      "MIDPLANE_DSN_01HXYZMAIN0000000000000000=postgres://example",
    );
    expect(runArgs).not.toContain("DATABASE_URL=postgres://example");
    expect(runArgs).toContain("MIDPLANE_POLICY_FILE=/etc/midplane/policy.yaml");

    // The bind mount is `<host_path>:/etc/midplane/policy.yaml:ro`. Pull
    // the host path back out and confirm the file exists with the
    // expected serialized YAML — proves the spawner materialized it
    // before the docker run.
    const mountArg = runArgs.find(
      (a) => typeof a === "string" && a.endsWith(":/etc/midplane/policy.yaml:ro"),
    );
    expect(mountArg).toBeDefined();
    const hostPath = mountArg!.split(":")[0]!;
    const yaml = await readFile(hostPath, "utf8");
    expect(yaml).toBe(
      [
        "databases:",
        "  - name: main",
        "    url: ${MIDPLANE_DSN_01HXYZMAIN0000000000000000}",
        "    table_access:",
        "      default: read",
        "      tables:",
        "        users: deny",
        "    guardrails:",
        "      block_unqualified_dml: true",
        "      block_ddl: true",
        "",
      ].join("\n"),
    );

    await c.stop();
    const stopCall = exec.mock.calls.find((c) => c[1]?.[0] === "stop");
    expect(stopCall).toBeDefined();
  });

  it("force-removes a leaked same-name container before spawning (restart-after-hard-kill)", async () => {
    const order: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      order.push(args);
      if (args[0] === "run") return { stdout: "cid\n" };
      if (args[0] === "port") return { stdout: "0.0.0.0:5002\n" };
      return { stdout: "" };
    });
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const spawner = new DockerSpawner({ exec, fetch: fetchFn, bootTimeoutMs: 1000 });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://x",
          tableAccess: { default: "deny", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true },
        },
      ],
    });

    // Container name = midplane-<first 16 of projectId, lowercased>.
    const name = "midplane-01hxyzconnabcdef";
    const rmIdx = order.findIndex((a) => a[0] === "rm" && a[2] === name);
    const runIdx = order.findIndex((a) => a[0] === "run");
    expect(rmIdx).toBeGreaterThanOrEqual(0); // pre-spawn cleanup happened…
    expect(rmIdx).toBeLessThan(runIdx); // …before the run.
    await c.stop();
  });

  it("injects MIDPLANE_MASK_SALT and emits the column_masks YAML when masking is configured", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "run") return { stdout: "cid\n" };
      if (args[0] === "port") return { stdout: "0.0.0.0:5000\n" };
      return { stdout: "" };
    });
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const spawner = new DockerSpawner({ exec, fetch: fetchFn, bootTimeoutMs: 1000 });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      maskSalt: "derived-project-salt",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://x",
          tableAccess: { default: "read", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true },
          columnMasks: { "public.users": { email: "full-redact" } },
        },
      ],
    });

    const runArgs = exec.mock.calls.find((c) => c[1]?.[0] === "run")?.[1] ?? [];
    expect(runArgs).toContain("MIDPLANE_MASK_SALT=derived-project-salt");

    const mountArg = runArgs.find(
      (a) => typeof a === "string" && a.endsWith(":/etc/midplane/policy.yaml:ro"),
    );
    const yaml = await readFile(mountArg!.split(":")[0]!, "utf8");
    expect(yaml).toContain("    requires_features:\n      - column_masks");
    expect(yaml).toContain(
      "    column_masks:\n      public.users:\n        email: full-redact",
    );

    await c.stop();
  });

  it("omits MIDPLANE_MASK_SALT and the column_masks block when no masking is set", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "run") return { stdout: "cid\n" };
      if (args[0] === "port") return { stdout: "0.0.0.0:5001\n" };
      return { stdout: "" };
    });
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const spawner = new DockerSpawner({ exec, fetch: fetchFn, bootTimeoutMs: 1000 });

    const c = await spawner.spawn({
      projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
      region: "eu",
      databases: [
        {
          name: "main",
          projectDatabaseId: "01HXYZMAIN0000000000000000",
          dsn: "postgres://x",
          tableAccess: { default: "read", tables: {} },
          tenantScope: { column: null, overrides: {}, exempt: [] },
          guardrails: { block_unqualified_dml: true, block_ddl: true },
        },
      ],
    });

    const runArgs = exec.mock.calls.find((c) => c[1]?.[0] === "run")?.[1] ?? [];
    expect(
      runArgs.some(
        (a) => typeof a === "string" && a.startsWith("MIDPLANE_MASK_SALT="),
      ),
    ).toBe(false);
    await c.stop();
  });

  it("removes container if health never becomes ready", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "run") return { stdout: "cid\n" };
      if (args[0] === "port") return { stdout: "0.0.0.0:1\n" };
      return { stdout: "" };
    });
    const fetchFn = vi.fn(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;

    const spawner = new DockerSpawner({
      exec,
      fetch: fetchFn,
      bootTimeoutMs: 50,
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
            guardrails: { block_unqualified_dml: true, block_ddl: true },
          },
        ],
      }),
    ).rejects.toThrow(/did not become healthy/);

    // The TEARDOWN removal (by container id "cid"), distinct from the
    // best-effort pre-spawn `rm -f <name>` that clears a leaked container.
    const rmCall = exec.mock.calls.find(
      (c) => c[1]?.[0] === "rm" && c[1]?.[2] === "cid",
    );
    expect(rmCall).toBeDefined();
  });

  it("rejects an empty databases array", async () => {
    const spawner = new DockerSpawner({});
    await expect(
      spawner.spawn({
        projectId: "01HXYZCONNABCDEFGHIJKLMNOP",
        region: "eu",
        databases: [],
      }),
    ).rejects.toThrow(/at least one database/);
  });
});
