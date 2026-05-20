import { describe, expect, it } from "vitest";

import { defaultRegionForCountry } from "../src/lib/region";

describe("defaultRegionForCountry", () => {
  it("maps EU countries to eu", () => {
    expect(defaultRegionForCountry("DE")).toBe("eu");
    expect(defaultRegionForCountry("FR")).toBe("eu");
    expect(defaultRegionForCountry("GB")).toBe("eu");
  });

  it("maps US/other to us", () => {
    expect(defaultRegionForCountry("US")).toBe("us");
    expect(defaultRegionForCountry("BR")).toBe("us");
  });

  it("returns null when country is unknown", () => {
    expect(defaultRegionForCountry(null)).toBeNull();
    expect(defaultRegionForCountry(undefined)).toBeNull();
    expect(defaultRegionForCountry("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(defaultRegionForCountry("de")).toBe("eu");
  });
});
