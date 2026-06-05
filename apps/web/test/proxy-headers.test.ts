// Regression guard for the fly-replay leak. The OSS engine sets
// `fly-replay: cache_key=<session>` on /mcp responses for Fly anycast
// affinity. We proxy directly to the per-token machine, so that header must
// be stripped before the response reaches the public Fly edge — otherwise
// fly-proxy replays the request, loops, and returns [PA02] "'fly-replay'
// response header was returned too many times" → every MCP call 502s.

import { describe, expect, it } from "vitest";

import { filterUpstreamResponseHeaders } from "../src/lib/proxy.ts";

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
