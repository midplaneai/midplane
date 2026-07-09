// Pure-function coverage for the two project health axes.
//
// Axis 1 — resolveServing: the headline "Hosted MCP server" dot. ready /
// paused / broken — will this project serve an MCP query. Deliberately takes
// no audit cursor, so a drain error can never turn the headline red.
//
// Axis 2 — computeFreshness / resolveFreshness: the demoted audit-drain
// signal. "live" (default — the project is ready, including the
// awaiting-first-query case) and "down" (indexer error newer than the last
// good drain). The previous "no traffic in >1h → stale" rule was dropped
// because it fired right after creation as a scary warning.

import { describe, expect, it } from "vitest";

import {
  AUDIT_DELAY_GRACE_MS,
  computeFreshness,
  resolveAuditHealth,
  resolveFreshness,
  resolveServing,
} from "../src/lib/freshness.ts";

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

describe("resolveFreshness — pause override", () => {
  const liveCursor = {
    lastIndexedAt: new Date(NOW.getTime() - 30 * 60_000),
    lastErrorAt: null,
  };
  const downCursor = {
    lastIndexedAt: new Date(NOW.getTime() - 30 * 60_000),
    lastErrorAt: new Date(NOW.getTime() - 60_000),
  };

  it("returns 'paused' when pausedAt is set, regardless of a live cursor", () => {
    expect(resolveFreshness(liveCursor, NOW)).toBe("paused");
  });

  it("returns 'paused' even when the indexer cursor says down", () => {
    // The kill switch wins over the indexer signal — the project is
    // gated by the owner, not broken.
    expect(resolveFreshness(downCursor, NOW)).toBe("paused");
  });

  it("delegates to computeFreshness when pausedAt is null", () => {
    expect(resolveFreshness(liveCursor, null)).toBe("live");
    expect(resolveFreshness(downCursor, null)).toBe("down");
  });
});

describe("resolveServing — headline serving readiness", () => {
  it("is ready when not paused and at least one database exists", () => {
    expect(resolveServing({ pausedAt: null, databaseCount: 1 })).toEqual({
      state: "ready",
      reason: null,
    });
  });

  it("is broken/no_database when not paused and no databases exist", () => {
    expect(resolveServing({ pausedAt: null, databaseCount: 0 })).toEqual({
      state: "broken",
      reason: "no_database",
    });
  });

  it("is paused when pausedAt is set, regardless of database count", () => {
    expect(resolveServing({ pausedAt: NOW, databaseCount: 3 })).toEqual({
      state: "paused",
      reason: null,
    });
  });

  it("prefers paused over broken (paused wins even with no databases)", () => {
    // A paused project with no databases reads "paused", not "action
    // needed" — Resume is the unambiguous next step, not "add a database".
    expect(resolveServing({ pausedAt: NOW, databaseCount: 0 })).toEqual({
      state: "paused",
      reason: null,
    });
  });

  it("does not depend on the audit-drain cursor at all", () => {
    // The whole point: a project whose indexer is erroring still serves.
    // resolveServing takes no cursor input, so there is no way for an audit
    // error to turn the headline red.
    expect(resolveServing({ pausedAt: null, databaseCount: 2 }).state).toBe(
      "ready",
    );
  });
});

describe("resolveAuditHealth — secondary audit-drain line", () => {
  it("is idle when the indexer has never drained and never errored", () => {
    expect(
      resolveAuditHealth({ lastIndexedAt: null, lastErrorAt: null }, NOW),
    ).toBe("idle");
  });

  it("is current after a successful drain with no fresh error", () => {
    expect(
      resolveAuditHealth(
        { lastIndexedAt: new Date(NOW.getTime() - 30 * 60_000), lastErrorAt: null },
        NOW,
      ),
    ).toBe("current");
  });

  it("rides out a brief blip — a fresh error whose last good drain is recent stays current", () => {
    // Engine restart: one drain fails, but the last SUCCESS was 2m ago — well
    // inside the grace window, so we don't alarm.
    expect(
      resolveAuditHealth(
        {
          lastIndexedAt: new Date(NOW.getTime() - 2 * 60_000),
          lastErrorAt: new Date(NOW.getTime() - 30_000),
        },
        NOW,
      ),
    ).toBe("current");
  });

  it("is delayed once the last successful drain is older than the grace window", () => {
    // lastErrorAt is fresh (the indexer re-stamps it every failed poll), but
    // the last SUCCESS is well past the grace window → genuinely behind.
    expect(
      resolveAuditHealth(
        {
          lastIndexedAt: new Date(NOW.getTime() - AUDIT_DELAY_GRACE_MS - 60_000),
          lastErrorAt: new Date(NOW.getTime() - 30_000),
        },
        NOW,
      ),
    ).toBe("error");
  });

  it("treats exactly the grace boundary as delayed (>=)", () => {
    expect(
      resolveAuditHealth(
        {
          lastIndexedAt: new Date(NOW.getTime() - AUDIT_DELAY_GRACE_MS),
          lastErrorAt: new Date(NOW.getTime() - 30_000),
        },
        NOW,
      ),
    ).toBe("error");
  });

  it("is error (a first-use outage) when erroring before the first successful drain", () => {
    // No successful drain ever + already erroring → surface it now, don't hide
    // it as "no activity yet". There's real query activity not reaching the
    // audit log, and no success to measure a grace window from.
    expect(
      resolveAuditHealth(
        { lastIndexedAt: null, lastErrorAt: new Date(NOW.getTime() - 60_000) },
        NOW,
      ),
    ).toBe("error");
  });

  it("is current when a good drain superseded an older error", () => {
    expect(
      resolveAuditHealth(
        {
          lastIndexedAt: new Date(NOW.getTime() - 60_000),
          lastErrorAt: new Date(NOW.getTime() - 30 * 60_000),
        },
        NOW,
      ),
    ).toBe("current");
  });
});
