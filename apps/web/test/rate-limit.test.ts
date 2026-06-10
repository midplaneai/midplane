// Fixed-window limiter for the ping/test surfaces. Injectable clock —
// no fake timers needed.

import { beforeEach, describe, expect, it } from "vitest";

import { checkRateLimit, resetRateLimits } from "../src/lib/rate-limit.ts";

const OPTS = { limit: 3, windowMs: 60_000 };
const T0 = 1_750_000_000_000;

describe("checkRateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit within a window, then rejects with retry-after", () => {
    expect(checkRateLimit("k", { ...OPTS, now: T0 })).toEqual({ ok: true });
    expect(checkRateLimit("k", { ...OPTS, now: T0 + 1000 })).toEqual({
      ok: true,
    });
    expect(checkRateLimit("k", { ...OPTS, now: T0 + 2000 })).toEqual({
      ok: true,
    });
    const rejected = checkRateLimit("k", { ...OPTS, now: T0 + 3000 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.retryAfterS).toBe(57);
  });

  it("resets after the window elapses", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("k", { ...OPTS, now: T0 });
    }
    expect(checkRateLimit("k", { ...OPTS, now: T0 + 60_000 })).toEqual({
      ok: true,
    });
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("a", { ...OPTS, now: T0 });
    expect(checkRateLimit("a", { ...OPTS, now: T0 }).ok).toBe(false);
    expect(checkRateLimit("b", { ...OPTS, now: T0 }).ok).toBe(true);
  });
});
