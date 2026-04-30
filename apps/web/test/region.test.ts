import { describe, expect, it } from "vitest";

import { defaultRegionForCountry } from "../src/lib/region";

describe("defaultRegionForCountry", () => {
  it("maps EU countries to fra", () => {
    expect(defaultRegionForCountry("DE")).toBe("fra");
    expect(defaultRegionForCountry("FR")).toBe("fra");
    expect(defaultRegionForCountry("GB")).toBe("fra");
  });

  it("maps US/other to iad", () => {
    expect(defaultRegionForCountry("US")).toBe("iad");
    expect(defaultRegionForCountry("BR")).toBe("iad");
    expect(defaultRegionForCountry(null)).toBe("iad");
  });

  it("is case-insensitive", () => {
    expect(defaultRegionForCountry("de")).toBe("fra");
  });
});
