import { describe, expect, it, vi } from "vitest";

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
      image: "midplane/midplane:0.1.0",
      exec,
      fetch: fetchFn,
      bootTimeoutMs: 1000,
    });

    const c = await spawner.spawn({
      token: "tok-abc",
      region: "fra",
      dsn: "postgres://example",
    });

    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(33001);
    expect(exec).toHaveBeenCalled();

    const runArgs = exec.mock.calls[0]?.[1] ?? [];
    expect(runArgs).toContain("midplane/midplane:0.1.0");
    expect(runArgs).toContain("DATABASE_URL=postgres://example");

    await c.stop();
    const stopCall = exec.mock.calls.find((c) => c[1]?.[0] === "stop");
    expect(stopCall).toBeDefined();
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
      spawner.spawn({ token: "t", region: "fra", dsn: "postgres://x" }),
    ).rejects.toThrow(/did not become healthy/);

    const rmCall = exec.mock.calls.find((c) => c[1]?.[0] === "rm");
    expect(rmCall).toBeDefined();
  });
});
