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
    c.set("conn1", "eu", "postgres://x");
    clock.advance(60_000);
    const r = c.get("conn1", "eu");
    expect(r.kind).toBe("fresh");
    if (r.kind === "fresh") expect(r.plaintext).toBe("postgres://x");
  });

  it("returns 'grace' past TTL but inside grace window", () => {
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.set("conn1", "eu", "postgres://x");
    clock.advance(11 * 60_000); // 1 min past TTL
    const r = c.get("conn1", "eu");
    expect(r.kind).toBe("grace");
  });

  it("returns 'expired' past TTL + grace (70 minutes)", () => {
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.set("conn1", "eu", "postgres://x");
    clock.advance(71 * 60_000);
    const r = c.get("conn1", "eu");
    expect(r.kind).toBe("expired");
  });

  it("returns 'miss' for unknown keys", () => {
    const c = new DecryptCache();
    expect(c.get("nope", "eu").kind).toBe("miss");
  });

  it("region scoping isolates eu and us entries", () => {
    const c = new DecryptCache();
    c.set("conn1", "eu", "eu-dsn");
    expect(c.get("conn1", "us").kind).toBe("miss");
  });

  it("evicts the oldest entry past capacity", () => {
    const c = new DecryptCache({ capacity: 2 });
    c.set("a", "eu", "1");
    c.set("b", "eu", "2");
    c.set("c", "eu", "3");
    expect(c.get("a", "eu").kind).toBe("miss");
    expect(c.get("b", "eu").kind).toBe("fresh");
    expect(c.get("c", "eu").kind).toBe("fresh");
  });

  it("invalidate drops the entry", () => {
    const c = new DecryptCache();
    c.set("a", "eu", "x");
    c.invalidate("a", "eu");
    expect(c.get("a", "eu").kind).toBe("miss");
  });

  it("rotation fence: drops a set whose decryption started before invalidate", () => {
    // Race: caller began KMS at t=100; rotation invalidated at t=200; the
    // KMS plaintext arrives at t=300 and tries to set. Without the fence,
    // the cache would now hold OLD plaintext and serve the rotated-away
    // credential until TTL expires.
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    const decryptStartedAt = clock.now();
    clock.advance(100);
    c.invalidate("a", "eu");
    clock.advance(100);
    const ok = c.set("a", "eu", "old-plaintext", decryptStartedAt);
    expect(ok).toBe(false);
    expect(c.get("a", "eu").kind).toBe("miss");
  });

  it("rotation fence: accepts a set whose decryption started AFTER invalidate", () => {
    // Post-rotation request: cache miss → KMS with NEW ciphertext → set
    // arrives strictly after the invalidate fence and must succeed,
    // otherwise the cache would never repopulate.
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    c.invalidate("a", "eu");
    clock.advance(50);
    const decryptStartedAt = clock.now();
    clock.advance(50);
    const ok = c.set("a", "eu", "new-plaintext", decryptStartedAt);
    expect(ok).toBe(true);
    const r = c.get("a", "eu");
    expect(r.kind).toBe("fresh");
    if (r.kind === "fresh") expect(r.plaintext).toBe("new-plaintext");
  });

  it("rotation fence: a late stale set does NOT overwrite an already-fresh entry", () => {
    // Compound race: post-rotation request landed NEW plaintext; a
    // stragglier pre-rotation grace refresh arrives later. The fence must
    // drop the straggler so it doesn't replace the new value.
    const clock = fakeNow();
    const c = new DecryptCache({ now: clock.now });
    const stragglerStartedAt = clock.now();
    clock.advance(100);
    c.invalidate("a", "eu");
    clock.advance(100);
    const freshStartedAt = clock.now();
    c.set("a", "eu", "new-plaintext", freshStartedAt);
    clock.advance(100);
    // Straggler arrives now with the OLD timestamp.
    const ok = c.set("a", "eu", "old-plaintext", stragglerStartedAt);
    expect(ok).toBe(false);
    const r = c.get("a", "eu");
    expect(r.kind).toBe("fresh");
    if (r.kind === "fresh") expect(r.plaintext).toBe("new-plaintext");
  });
});
