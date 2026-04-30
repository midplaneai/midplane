// Liveness probe contract: returns 200 with { ok: true } and does NOT
// touch the database. The route module must not import the db client —
// otherwise a Postgres outage would fail-closed the Fly health check
// and trigger control-plane restarts on a bad day for Neon.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns 200 with { ok: true }", async () => {
    const { GET } = await import("../src/app/api/health/route.ts");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not import the db client", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/app/api/health/route.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/@midplane-cloud\/db/);
    expect(source).not.toMatch(/getDb\s*\(/);
  });

  // Fly's [[http_service.checks]] polls /api/health with no auth header.
  // Clerk's middleware would 404 it unless the route is explicitly listed
  // in the public matcher, so guard the contract here — losing this lets
  // a deploy go red on every health interval.
  it("is listed as a public route in middleware", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/middleware.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/["'`]\/api\/health["'`]/);
  });
});
