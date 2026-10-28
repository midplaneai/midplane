// Release versions: `X.Y.Z` with numbers only, ordered number by number, so
// the cloud can say a gateway is behind and never misreads a dev build or a
// release candidate as one.

import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "../src/index.ts";

describe("a release version", () => {
  // protects=a release's version reads as its three numbers;
  // fails_when=a release is refused, or its numbers are misread;
  // no_claim=none beyond protects
  it("parses X.Y.Z as three numbers", () => {
    expect(parseVersion("0.24.0")).toEqual([0, 24, 0]);
    expect(parseVersion("1.0.10")).toEqual([1, 0, 10]);
    expect(parseVersion("0.0.0")).toEqual([0, 0, 0]);
  });

  // protects=only a final release parses: a dev build, a release candidate, a tag or anything else is null;
  // fails_when=`dev`, `0.25.0-rc.1`, `v0.24.0` or a malformed version parses;
  // no_claim=none beyond protects
  it("is null for anything that isn't a release", () => {
    for (const v of [
      "dev",
      "test",
      "0.25.0-rc.1",
      "0.24.0+build.5",
      "v0.24.0",
      "0.24",
      "0.24.0.1",
      " 0.24.0",
      "0.24.0\n",
      "01.2.3",
      "0.x.0",
      "",
      `0.${"9".repeat(20)}.0`,
    ]) {
      expect(parseVersion(v), JSON.stringify(v)).toBeNull();
    }
  });

  // protects=versions order number by number;
  // fails_when=`0.10.0 < 0.9.0`, as text would order them, or a patch outweighs a minor;
  // no_claim=none beyond protects
  it("orders by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.22.0", "0.24.0")).toBeLessThan(0);
    expect(compareVersions("0.24.1", "0.24.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.23.9", "0.24.0")).toBeLessThan(0);
  });

  // protects=equal versions compare equal;
  // fails_when=an equal version reads as behind or ahead;
  // no_claim=none beyond protects
  it("compares equal versions as equal", () => {
    expect(compareVersions("0.24.0", "0.24.0")).toBe(0);
  });

  // protects=sorting by it puts releases in order;
  // fails_when=a list sorted with it is out of order;
  // no_claim=none beyond protects
  it("sorts a list of releases", () => {
    expect(
      ["0.10.0", "0.9.1", "0.23.1", "0.24.0", "0.9.0"].sort(compareVersions),
    ).toEqual(["0.9.0", "0.9.1", "0.10.0", "0.23.1", "0.24.0"]);
  });

  // protects=nothing that isn't a release is ever compared;
  // fails_when=`dev` compares as some number and reads as behind or ahead;
  // no_claim=none beyond protects
  it("refuses to compare what doesn't parse", () => {
    expect(() => compareVersions("dev", "0.24.0")).toThrow(/dev/);
    expect(() => compareVersions("0.24.0", "0.25.0-rc.1")).toThrow(/rc/);
  });
});
