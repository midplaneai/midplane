// Unit coverage for the entitlement chokepoint (lib/plan.ts) as wired for ee/SSO.
//
// hasEntitlement(feature) is the single feature gate. An ee feature needs BOTH
// the build switch (MIDPLANE_EE) AND the per-org plan cap. These tests exercise
// the DB-free paths: flag-off (returns immediately) and self-host (resolvePlan
// short-circuits to SELF_HOST_CAPS before any DB read). The cloud Team path is
// covered structurally via the CAPS map.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CAPS,
  SELF_HOST_CAPS,
  eeBuildEnabled,
  hasEntitlement,
} from "../src/lib/plan.ts";

const prevEe = process.env.MIDPLANE_EE;
const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

function restore(key: "MIDPLANE_EE" | "MIDPLANE_SELF_HOST", prev?: string) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe("eeBuildEnabled", () => {
  beforeEach(() => delete process.env.MIDPLANE_EE);
  afterEach(() => restore("MIDPLANE_EE", prevEe));

  it("true only when MIDPLANE_EE === '1'", () => {
    expect(eeBuildEnabled()).toBe(false);
    process.env.MIDPLANE_EE = "1";
    expect(eeBuildEnabled()).toBe(true);
    process.env.MIDPLANE_EE = "true";
    expect(eeBuildEnabled()).toBe(false);
  });
});

describe("CAPS — sso entitlement by tier", () => {
  it("Team has sso; Free and Pro do not", () => {
    expect(CAPS.team.sso).toBe(true);
    expect(CAPS.pro.sso).toBe(false);
    expect(CAPS.free.sso).toBe(false);
  });

  it("self-host is uncapped core but sso stays false (ee-gated)", () => {
    expect(SELF_HOST_CAPS.sso).toBe(false);
    expect(SELF_HOST_CAPS.connections).toBe(Infinity);
  });
});

describe("hasEntitlement('sso')", () => {
  beforeEach(() => {
    delete process.env.MIDPLANE_EE;
    delete process.env.MIDPLANE_SELF_HOST;
  });
  afterEach(() => {
    restore("MIDPLANE_EE", prevEe);
    restore("MIDPLANE_SELF_HOST", prevSelfHost);
  });

  it("false when the ee build switch is off — short-circuits before any plan read", async () => {
    expect(await hasEntitlement("sso")).toBe(false);
  });

  it("false in self-host even with the ee flag set (caps.sso is false)", async () => {
    process.env.MIDPLANE_EE = "1";
    process.env.MIDPLANE_SELF_HOST = "1";
    expect(await hasEntitlement("sso")).toBe(false);
  });
});
