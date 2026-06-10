// Unit coverage for the shared relative-time helpers. These replaced
// three per-file copies (dashboard DatabaseRow, per-DB detail page,
// token list) — the assertions pin the exact strings those surfaces
// render so a drive-by "improvement" to one consumer can't silently
// change the others.

import { describe, expect, it } from "vitest";

import { formatRelative, formatRelativeLong } from "../src/lib/format.ts";

const NOW = new Date("2026-06-10T12:00:00Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelative (short form)", () => {
  it("renders just now under a minute", () => {
    expect(formatRelative(ago(0), NOW)).toBe("just now");
    expect(formatRelative(ago(59_000), NOW)).toBe("just now");
  });

  it("renders minutes, hours, days at the boundaries", () => {
    expect(formatRelative(ago(MIN), NOW)).toBe("1m ago");
    expect(formatRelative(ago(59 * MIN), NOW)).toBe("59m ago");
    expect(formatRelative(ago(HOUR), NOW)).toBe("1h ago");
    expect(formatRelative(ago(23 * HOUR), NOW)).toBe("23h ago");
    expect(formatRelative(ago(DAY), NOW)).toBe("1d ago");
    expect(formatRelative(ago(45 * DAY), NOW)).toBe("45d ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(formatRelative(new Date(NOW.getTime() + HOUR), NOW)).toBe(
      "just now",
    );
  });
});

describe("formatRelativeLong (prose form)", () => {
  it("renders just now under a minute", () => {
    expect(formatRelativeLong(ago(59_000), NOW)).toBe("just now");
  });

  it("pluralizes correctly", () => {
    expect(formatRelativeLong(ago(MIN), NOW)).toBe("1 minute ago");
    expect(formatRelativeLong(ago(2 * MIN), NOW)).toBe("2 minutes ago");
    expect(formatRelativeLong(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(formatRelativeLong(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(formatRelativeLong(ago(DAY), NOW)).toBe("1 day ago");
    expect(formatRelativeLong(ago(9 * DAY), NOW)).toBe("9 days ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(formatRelativeLong(new Date(NOW.getTime() + DAY), NOW)).toBe(
      "just now",
    );
  });
});
