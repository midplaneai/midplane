import { describe, expect, it } from "vitest";

import { loadRegions, mintMcpUrl } from "../src/region.ts";

describe("loadRegions", () => {
  it("falls back to localhost:3000 in dev (Next.js handles /mcp/<token> directly)", () => {
    const r = loadRegions({} as NodeJS.ProcessEnv);
    expect(r.fra.publicHost).toBe("localhost:3000");
    expect(r.iad.publicHost).toBe("localhost:3000");
  });

  it("respects env overrides", () => {
    const r = loadRegions({
      MIDPLANE_PUBLIC_HOST_FRA: "fra.midplane.com",
      FLY_APP_FRA: "midplane-fra-prod",
    } as NodeJS.ProcessEnv);
    expect(r.fra.publicHost).toBe("fra.midplane.com");
    expect(r.fra.flyApp).toBe("midplane-fra-prod");
  });
});

describe("mintMcpUrl", () => {
  it("produces https://<region>.midplane.com/mcp/<token> in prod-shaped envs", () => {
    const url = mintMcpUrl("fra", "tok_abc", {
      MIDPLANE_PUBLIC_HOST_FRA: "fra.midplane.com",
    } as NodeJS.ProcessEnv);
    expect(url).toBe("https://fra.midplane.com/mcp/tok_abc");
  });

  it("produces http://localhost:3000 in dev", () => {
    const url = mintMcpUrl("fra", "tok_abc", {} as NodeJS.ProcessEnv);
    expect(url).toBe("http://localhost:3000/mcp/tok_abc");
  });
});
