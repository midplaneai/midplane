// Boot-time guard: hosted (FLY_API_TOKEN set) without INDEXER_TOKEN
// disables the audit pipeline silently — we'd rather take the proxy
// down on startup than ship a deploy that returns successful MCP
// requests but never indexes anything to the dashboard.
//
// We only test the early throw here. The success paths (Docker dev,
// Fly hosted with both tokens) wire real DB + KMS + Drizzle, which
// would need integration-grade mocks; the indexer.test.ts + live E2E
// already cover those.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete (globalThis as Record<string, unknown>).__midplane_mcp_proxy__;
});

afterEach(() => {
  process.env = originalEnv;
  delete (globalThis as Record<string, unknown>).__midplane_mcp_proxy__;
});

describe("getMcpProxyContext", () => {
  it("throws when FLY_API_TOKEN is set without INDEXER_TOKEN (hosted requires audit)", async () => {
    process.env.FLY_API_TOKEN = "fly-api-secret";
    delete process.env.INDEXER_TOKEN;
    const { getMcpProxyContext } = await import("../src/lib/mcp-proxy.ts");
    expect(() => getMcpProxyContext()).toThrow(/INDEXER_TOKEN is required/);
  });
});
