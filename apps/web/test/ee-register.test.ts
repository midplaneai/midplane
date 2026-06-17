// Exercises the ENABLED ee path end of the seam: src/ee/register.ts builds the
// SSO plugin and registers it into the core registry only when MIDPLANE_EE=1.
// (The keyless path — flag off → registry empty → SSO dark — is the default and
// is also asserted here.) This test imports ee/, which is fine: it's an ee test
// and is deleted alongside ee/ in an MIT build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEeAuthPlugins,
  registerEeAuthPlugins,
} from "../src/lib/ee-plugins.ts";
import { buildSsoPlugins } from "../src/ee/sso/index.ts";
import { registerEe } from "../src/ee/register.ts";

const prevEe = process.env.MIDPLANE_EE;

describe("buildSsoPlugins", () => {
  it("constructs the SSO Better Auth plugin", () => {
    const plugins = buildSsoPlugins();
    expect(plugins).toHaveLength(1);
    // The @better-auth/sso plugin self-identifies as "sso".
    expect(plugins[0]?.id).toBe("sso");
  });
});

describe("registerEe — the ee bootstrap", () => {
  beforeEach(() => {
    delete process.env.MIDPLANE_EE;
    registerEeAuthPlugins([]);
  });
  afterEach(() => {
    if (prevEe === undefined) delete process.env.MIDPLANE_EE;
    else process.env.MIDPLANE_EE = prevEe;
    registerEeAuthPlugins([]);
  });

  it("registers nothing when the ee flag is off (keyless → SSO dark)", () => {
    registerEe();
    expect(getEeAuthPlugins()).toEqual([]);
  });

  it("registers the SSO plugin when MIDPLANE_EE=1", () => {
    process.env.MIDPLANE_EE = "1";
    registerEe();
    const plugins = getEeAuthPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe("sso");
  });
});
