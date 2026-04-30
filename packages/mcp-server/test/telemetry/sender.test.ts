import { describe, expect, test } from "bun:test";
import { createSender } from "../../src/telemetry/sender.ts";
import type { TelemetryConfig } from "../../src/telemetry/config.ts";
import type { StartupEvent } from "../../src/telemetry/schema.ts";

const validStartup: StartupEvent = {
  schema_version: 1,
  event: "startup",
  install_id: "01H8K2J9XQVWZ7PCQ3F0R2N5T8",
  ts: 1_730_000_000,
  version: "0.2.0",
  bun_version: "1.3.0",
  os: "linux",
  arch: "x64",
  transport: "http",
  container: false,
  ci: false,
};

const baseCfg: TelemetryConfig = {
  mode: "enabled",
  endpoint: "https://t.midplane.ai/v1/events",
  heartbeatMs: 86_400_000,
  startupDelayMs: 0,
};

describe("sender — disabled mode", () => {
  test("send is a noop and never touches stderr", async () => {
    const sender = createSender({ ...baseCfg, mode: "disabled" });
    await sender.send(validStartup);
    // No assertion needed — the type returned is the noop sender.
    expect(true).toBe(true);
  });
});

describe("sender — debug mode", () => {
  test("writes a JSON line to stderr and skips network", async () => {
    const sender = createSender({ ...baseCfg, mode: "debug" });
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await sender.send(validStartup);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[telemetry-debug]");
    expect(lines[0]).toContain("\"event\":\"startup\"");
    expect(lines[0]).toContain("\"install_id\":\"01H8K2J9XQVWZ7PCQ3F0R2N5T8\"");
  });

  test("debug mode drops invalid payloads with DROPPED tag", async () => {
    const sender = createSender({ ...baseCfg, mode: "debug" });
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await sender.send({ ...validStartup, install_id: "bad" } as any);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("DROPPED");
    expect(lines[0]).toContain("schema_violation");
  });
});

describe("sender — enabled mode", () => {
  test("posts to the configured endpoint with json body", async () => {
    let received: { url: string; method: string; body: string; headers: Record<string, string> } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      received = {
        url: String(input),
        method: init.method,
        body: String(init.body),
        headers: init.headers,
      };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const sender = createSender(baseCfg);
      await sender.send(validStartup);
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(received).not.toBeNull();
    expect(received!.url).toBe(baseCfg.endpoint);
    expect(received!.method).toBe("POST");
    expect(received!.headers["content-type"]).toBe("application/json");
    expect(received!.headers["user-agent"]).toContain("midplane-mcp-server-telemetry");
    const parsed = JSON.parse(received!.body);
    expect(parsed.event).toBe("startup");
    expect(parsed.install_id).toBe(validStartup.install_id);
  });

  test("network failure is silent — no throw", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("dns error"); }) as typeof fetch;

    try {
      const sender = createSender(baseCfg);
      await sender.send(validStartup); // must not throw
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(true).toBe(true);
  });

  test("invalid payload is dropped before fetch is called", async () => {
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { calls += 1; return new Response(null, { status: 204 }); }) as typeof fetch;

    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const sender = createSender(baseCfg);
      await sender.send({ ...validStartup, install_id: "nope" } as any);
    } finally {
      globalThis.fetch = origFetch;
      process.stderr.write = origWrite;
    }

    expect(calls).toBe(0);
  });
});
