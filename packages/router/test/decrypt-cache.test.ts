import { describe, expect, it } from "vitest";

import { DecryptCache } from "../src/decrypt-cache.ts";

function fakeNow() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("DecryptCache", () => {
  it("returns 'fresh' inside TTL", () => {
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.set("conn1", "fra", "postgres://x");
    clock.advance(60_000);
    const r = c.get("conn1", "fra");
    expect(r.kind).toBe("fresh");
    if (r.kind === "fresh") expect(r.plaintext).toBe("postgres://x");
  });

  it("returns 'grace' past TTL but inside grace window", () => {
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.set("conn1", "fra", "postgres://x");
    clock.advance(11 * 60_000); // 1 min past TTL
    const r = c.get("conn1", "fra");
    expect(r.kind).toBe("grace");
  });

  it("returns 'expired' past TTL + grace (70 minutes)", () => {
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.set("conn1", "fra", "postgres://x");
    clock.advance(71 * 60_000);
    const r = c.get("conn1", "fra");
    expect(r.kind).toBe("expired");
  });

  it("returns 'miss' for unknown keys", () => {
    const c = new DecryptCache();
    expect(c.get("nope", "fra").kind).toBe("miss");
  });

  it("region scoping isolates fra and iad entries", () => {
    const c = new DecryptCache();
    c.set("conn1", "fra", "fra-dsn");
    expect(c.get("conn1", "iad").kind).toBe("miss");
  });

  it("evicts the oldest entry past capacity", () => {
    const c = new DecryptCache({ capacity: 2 });
    c.set("a", "fra", "1");
    c.set("b", "fra", "2");
    c.set("c", "fra", "3");
    expect(c.get("a", "fra").kind).toBe("miss");
    expect(c.get("b", "fra").kind).toBe("fresh");
    expect(c.get("c", "fra").kind).toBe("fresh");
  });

  it("invalidate drops the entry", () => {
    const c = new DecryptCache();
    c.set("a", "fra", "x");
    c.invalidate("a", "fra");
    expect(c.get("a", "fra").kind).toBe("miss");
  });
});
