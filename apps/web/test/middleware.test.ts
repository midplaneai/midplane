import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import middleware from "../src/middleware";

const APEX = "https://app.midplane.ai";

async function run(
  url: string,
): Promise<{ status: number; location: string | null; isNext: boolean }> {
  const res = await middleware(new NextRequest(url));
  return {
    status: res.status,
    location: res.headers.get("location"),
    // NextResponse.next() marks the response so Next continues the pipeline.
    isNext: res.headers.get("x-middleware-next") === "1",
  };
}

describe("middleware — apex signup routing", () => {
  it("forces the region picker before signup on the apex (no region cookie)", async () => {
    const r = await run(`${APEX}/sign-up`);
    expect(r.location).toBe(`${APEX}/signup`);
  });

  it("redirects a mistyped /sign-up/region to the real picker", async () => {
    const r = await run(`${APEX}/sign-up/region`);
    expect(r.location).toBe(`${APEX}/signup`);
  });

  it("lets the picker itself render on the apex", async () => {
    const r = await run(`${APEX}/signup`);
    expect(r.location).toBeNull();
    expect(r.isNext).toBe(true);
  });

  it("does not redirect /sign-in on the apex (returning-user cookie-miss is deferred)", async () => {
    const r = await run(`${APEX}/sign-in`);
    expect(r.location).toBeNull();
    expect(r.isNext).toBe(true);
  });

  it("still renders /sign-up on a regional subdomain, where region-resident signup happens", async () => {
    const r = await run("https://eu.app.midplane.ai/sign-up");
    expect(r.location).toBeNull();
    expect(r.isNext).toBe(true);
  });
});
