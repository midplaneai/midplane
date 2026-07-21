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

// Behind Fly, TLS terminates at the proxy and the request is forwarded to the
// app over an INTERNAL origin — so req.url carries the internal listen host
// ("localhost:3000") while the PUBLIC host lives only in the Host header. This
// helper reproduces that split (URL host = internal, Host header = public); the
// plain run() above can't, because NextRequest(url) derives the Host header
// from the URL, making them agree. path is joined onto the internal origin.
async function runProxied(
  publicHost: string,
  path: string,
): Promise<{ status: number; location: string | null; isNext: boolean }> {
  const res = await middleware(
    new NextRequest(`http://localhost:3000${path}`, {
      headers: { host: publicHost },
    }),
  );
  return {
    status: res.status,
    location: res.headers.get("location"),
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

// Regression: behind Fly the apex host arrives in the Host header, not req.url
// (which is the internal listen origin). Reading req.url host made
// `host === APEX_HOST` always false, so the apex silently behaved like a
// regional subdomain: it applied the session-cookie auth-gate and bounced every
// protected route to /sign-in — a user with a live session on eu.app.midplane.ai
// (session cookie host-scoped there) looked logged out on app.midplane.ai. These
// assert the apex branch fires off the PUBLIC host even when req.url disagrees.
describe("middleware — apex detected from the Host header (behind a proxy)", () => {
  it("routes /sign-up to the region picker on the apex even when req.url host is internal", async () => {
    const r = await runProxied("app.midplane.ai", "/sign-up");
    // Apex branch (not the regional fallthrough, which renders /sign-up as-is).
    expect(r.location).toBe("http://localhost:3000/signup");
  });

  it("sends a protected apex path with no region cookie to the picker, NOT /sign-in", async () => {
    const r = await runProxied("app.midplane.ai", "/dashboard");
    // The bug sent this to /sign-in via the regional auth-gate; the apex branch
    // sends a cookie-less visitor to the region picker instead.
    expect(r.location).toBe("http://localhost:3000/signup");
  });

  it("a genuine regional subdomain in the Host header still uses the regional gate", async () => {
    // No session cookie → regional branch redirects to /sign-in (unchanged).
    const r = await runProxied("eu.app.midplane.ai", "/dashboard");
    expect(r.location).toBe("http://localhost:3000/sign-in");
  });
});
