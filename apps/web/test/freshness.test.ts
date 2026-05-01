// Pure-function coverage for the dashboard freshness dot.
//
// Two states for now: "live" (default — the connection is ready, including
// the awaiting-first-query case) and "down" (indexer error newer than the
// last good drain). The previous "no traffic in >1h → stale" rule was
// dropped because it fired right after creation as a scary warning, which
// is the wrong UX. A real "stale" state will come back when we have a
// signal for it in production.

import { describe, expect, it } from "vitest";

import { computeFreshness } from "../src/lib/freshness.ts";

const NOW = new Date("2026-05-01T12:00:00Z");

describe("computeFreshness", () => {
  it("is live with no traffic and no error (awaiting first query)", () => {
    expect(
      computeFreshness({ lastIndexedAt: null, lastErrorAt: null }),
    ).toBe("live");
  });

  it("is live with recent traffic and no error", () => {
    expect(
      computeFreshness({
        lastIndexedAt: new Date(NOW.getTime() - 30 * 60_000),
        lastErrorAt: null,
      }),
    ).toBe("live");
  });

  it("stays live even when traffic is hours old (no stale state for now)", () => {
    expect(
      computeFreshness({
        lastIndexedAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
        lastErrorAt: null,
      }),
    ).toBe("live");
  });

  it("is down when the error is newer than the last good drain", () => {
    expect(
      computeFreshness({
        lastIndexedAt: new Date(NOW.getTime() - 30 * 60_000),
        lastErrorAt: new Date(NOW.getTime() - 60_000),
      }),
    ).toBe("down");
  });

  it("is live when an old error has been superseded by a successful drain", () => {
    expect(
      computeFreshness({
        lastIndexedAt: new Date(NOW.getTime() - 60_000),
        lastErrorAt: new Date(NOW.getTime() - 30 * 60_000),
      }),
    ).toBe("live");
  });

  it("is down when an error has occurred but no drain has ever succeeded", () => {
    expect(
      computeFreshness({
        lastIndexedAt: null,
        lastErrorAt: new Date(NOW.getTime() - 60_000),
      }),
    ).toBe("down");
  });
});
