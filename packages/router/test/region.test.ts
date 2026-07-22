import { describe, expect, it } from "vitest";

import {
  loadRegions,
  mcpGenericUrl,
  mcpOrigin,
  mcpProjectUrl,
  mintMcpUrl,
} from "../src/region.ts";

describe("loadRegions", () => {
  it("falls back to localhost:3000 in dev (Next.js handles /mcp/<token> directly)", () => {
    const r = loadRegions({} as NodeJS.ProcessEnv);
    expect(r.eu.publicHost).toBe("localhost:3000");
    expect(r.us.publicHost).toBe("localhost:3000");
  });

  it("respects env overrides", () => {
    const r = loadRegions({
      MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai",
      FLY_APP_EU: "midplane-eu-prod",
    } as NodeJS.ProcessEnv);
    expect(r.eu.publicHost).toBe("eu.midplane.ai");
    expect(r.eu.flyApp).toBe("midplane-eu-prod");
  });

  it("defaults flyRegion to airport codes for the V1 jurisdictions", () => {
    const r = loadRegions({} as NodeJS.ProcessEnv);
    expect(r.eu.flyRegion).toBe("fra");
    expect(r.us.flyRegion).toBe("iad");
  });

  it("flyRegion is configurable so EU can route to ams later", () => {
    const r = loadRegions({ FLY_REGION_EU: "ams" } as NodeJS.ProcessEnv);
    expect(r.eu.flyRegion).toBe("ams");
  });
});

describe("mintMcpUrl", () => {
  it("produces https://<region>.midplane.ai/mcp/<token> in prod-shaped envs", () => {
    const url = mintMcpUrl("eu", "tok_abc", {
      MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://eu.midplane.ai/mcp/tok_abc");
  });

  it("produces http://localhost:3000 in dev", () => {
    const url = mintMcpUrl("eu", "tok_abc", {} as NodeJS.ProcessEnv);
    expect(url).toBe("http://localhost:3000/mcp/tok_abc");
  });

  it("derives the origin from BETTER_AUTH_URL in self-host (remapped port)", () => {
    const url = mintMcpUrl("eu", "mp_live_xyz", {
      MIDPLANE_SELF_HOST: "1",
      BETTER_AUTH_URL: "http://localhost:3210",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("http://localhost:3210/mcp/mp_live_xyz");
  });

  it("strips a trailing slash from BETTER_AUTH_URL in self-host", () => {
    const url = mintMcpUrl("eu", "mp_live_xyz", {
      MIDPLANE_SELF_HOST: "1",
      BETTER_AUTH_URL: "https://midplane.example.com/",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://midplane.example.com/mcp/mp_live_xyz");
  });

  it("ignores BETTER_AUTH_URL when NOT self-host (cloud stays per-region)", () => {
    const url = mintMcpUrl("eu", "tok_abc", {
      BETTER_AUTH_URL: "https://eu.midplane.ai",
      MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://eu.midplane.ai/mcp/tok_abc");
  });
});

describe("mcpGenericUrl", () => {
  it("produces https://<region>.midplane.ai/mcp — no id, no token", () => {
    const url = mcpGenericUrl("eu", {
      MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://eu.midplane.ai/mcp");
  });

  it("produces http://localhost:3000/mcp in dev", () => {
    const url = mcpGenericUrl("eu", {} as NodeJS.ProcessEnv);
    expect(url).toBe("http://localhost:3000/mcp");
  });

  it("derives the origin from BETTER_AUTH_URL in self-host (remapped port)", () => {
    const url = mcpGenericUrl("eu", {
      MIDPLANE_SELF_HOST: "1",
      BETTER_AUTH_URL: "http://localhost:3210",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("http://localhost:3210/mcp");
  });
});

// mcpOrigin feeds the mcp() plugin's OAuth protected-resource `resource`
// (apps/web/src/lib/auth.ts). The bug it fixes: Better Auth defaulted `resource`
// to the ISSUER origin (BETTER_AUTH_URL, `<region>.app.midplane.ai`), but agents
// connect to the MCP-endpoint host (`<region>.midplane.ai/mcp`); a strict client
// (Claude Code) rejects the mismatch. The advertised resource MUST be the origin
// the agent connects to, NOT the issuer origin.
describe("mcpOrigin (OAuth protected-resource `resource`)", () => {
  it("produces https://<region>.midplane.ai — origin only, no /mcp path", () => {
    expect(
      mcpOrigin("us", {
        MIDPLANE_PUBLIC_HOST_US: "us.midplane.ai",
      } as NodeJS.ProcessEnv),
    ).toBe("https://us.midplane.ai");
    expect(
      mcpOrigin("eu", {
        MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai",
      } as NodeJS.ProcessEnv),
    ).toBe("https://eu.midplane.ai");
  });

  it("advertises the MCP-endpoint origin, NOT the issuer (BETTER_AUTH_URL) origin", () => {
    // Cloud: issuer host (us.app.midplane.ai) and MCP host (us.midplane.ai) differ.
    // The resource must name the MCP host — advertising the issuer origin is the
    // exact defect that made Claude Code reject the connection.
    const env = {
      MIDPLANE_PUBLIC_HOST_US: "us.midplane.ai",
      BETTER_AUTH_URL: "https://us.app.midplane.ai",
    } as NodeJS.ProcessEnv;
    expect(mcpOrigin("us", env)).toBe("https://us.midplane.ai");
    expect(mcpOrigin("us", env)).not.toBe(
      new URL(env.BETTER_AUTH_URL!).origin,
    );
  });

  it("equals the origin of the MCP endpoint the agent connects to", () => {
    // The invariant a strict client enforces: origin(connect URL) === resource.
    // Ties the advertised resource to both endpoint shapes so a future regression
    // (e.g. setting resource to the `/mcp` path) is caught.
    const env = { MIDPLANE_PUBLIC_HOST_EU: "eu.midplane.ai" } as NodeJS.ProcessEnv;
    expect(new URL(mcpGenericUrl("eu", env)).origin).toBe(mcpOrigin("eu", env));
    expect(new URL(mcpProjectUrl("eu", "proj_123", env)).origin).toBe(
      mcpOrigin("eu", env),
    );
  });

  it("falls back to http://localhost:3000 in dev", () => {
    expect(mcpOrigin("eu", {} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:3000",
    );
  });

  it("uses the BETTER_AUTH_URL origin in self-host (issuer == endpoint, one host)", () => {
    expect(
      mcpOrigin("eu", {
        MIDPLANE_SELF_HOST: "1",
        BETTER_AUTH_URL: "https://midplane.example.com/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://midplane.example.com");
  });
});
