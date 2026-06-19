// Regression guard for the fly-replay leak. The OSS engine sets
// `fly-replay: cache_key=<session>` on /mcp responses for Fly anycast
// affinity. We proxy directly to the per-token machine, so that header must
// be stripped before the response reaches the public Fly edge — otherwise
// fly-proxy replays the request, loops, and returns [PA02] "'fly-replay'
// response header was returned too many times" → every MCP call 502s.

import { describe, expect, it } from "vitest";

import {
  buildForwardHeaders,
  filterUpstreamResponseHeaders,
} from "../src/lib/proxy.ts";

describe("filterUpstreamResponseHeaders", () => {
  it("strips fly-replay control headers so they can't loop the public edge", () => {
    const out = filterUpstreamResponseHeaders(
      new Headers({
        "content-type": "text/event-stream",
        "mcp-session-id": "sess-abc",
        "fly-replay": "cache_key=sess-abc",
        "fly-replay-src": "instance=abc;region=fra",
      }),
    );
    expect(out.get("fly-replay")).toBeNull();
    expect(out.get("fly-replay-src")).toBeNull();
    // Affinity is carried by mcp-session-id + the registry, not fly-replay —
    // and SSE needs its content-type — so those must survive.
    expect(out.get("mcp-session-id")).toBe("sess-abc");
    expect(out.get("content-type")).toBe("text/event-stream");
  });

  it("drops hop-by-hop headers but keeps everything else", () => {
    const out = filterUpstreamResponseHeaders(
      new Headers({
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "x-custom": "keep-me",
      }),
    );
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("connection")).toBeNull();
    expect(out.get("x-custom")).toBe("keep-me");
  });
});

describe("buildForwardHeaders — proxy is the sole authority for control headers", () => {
  it("stamps our token id over any client-supplied X-Midplane-Token-Id", () => {
    const out = buildForwardHeaders(
      new Headers({ "x-midplane-token-id": "client-forged", accept: "application/json" }),
      { tokenId: "real-token-id", scopeHeader: null },
    );
    expect(out.get("x-midplane-token-id")).toBe("real-token-id");
    expect(out.get("accept")).toBe("application/json"); // ordinary headers pass through
  });

  it("sets X-Midplane-Scope when the credential is scoped", () => {
    const out = buildForwardHeaders(new Headers(), {
      tokenId: "t",
      scopeHeader: '{"main":"read"}',
    });
    expect(out.get("x-midplane-scope")).toBe('{"main":"read"}');
  });

  it("strips a client-supplied X-Midplane-Scope when the credential is UNSCOPED", () => {
    // An unscoped credential must not be able to smuggle a scope to the engine.
    const out = buildForwardHeaders(
      new Headers({ "x-midplane-scope": '{"main":"write"}' }),
      { tokenId: "t", scopeHeader: null },
    );
    expect(out.get("x-midplane-scope")).toBeNull();
  });

  it("overrides a client-supplied X-Midplane-Scope with the resolved grant", () => {
    const out = buildForwardHeaders(
      new Headers({ "x-midplane-scope": '{"secret":"write"}' }),
      { tokenId: "t", scopeHeader: '{"main":"read"}' },
    );
    expect(out.get("x-midplane-scope")).toBe('{"main":"read"}');
  });

  it("drops hop-by-hop request headers", () => {
    const out = buildForwardHeaders(
      new Headers({ connection: "keep-alive", host: "evil", "x-keep": "yes" }),
      { tokenId: "t", scopeHeader: null },
    );
    expect(out.get("connection")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("x-keep")).toBe("yes");
  });
});
