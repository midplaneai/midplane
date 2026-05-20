import { describe, expect, it } from "vitest";

import { tokenEnvFromConfig } from "../src/lib/token-env.ts";

describe("tokenEnvFromConfig", () => {
  it("override wins over NODE_ENV", () => {
    expect(
      tokenEnvFromConfig({
        MIDPLANE_TOKEN_ENV: "live",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toBe("live");
    expect(
      tokenEnvFromConfig({
        MIDPLANE_TOKEN_ENV: "test",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe("test");
  });

  it("invalid override falls through to NODE_ENV mapping", () => {
    expect(
      tokenEnvFromConfig({
        MIDPLANE_TOKEN_ENV: "staging",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe("live");
  });

  it("NODE_ENV=production → live; anything else → test", () => {
    expect(
      tokenEnvFromConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe("live");
    expect(
      tokenEnvFromConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).toBe("test");
    expect(tokenEnvFromConfig({} as NodeJS.ProcessEnv)).toBe("test");
  });
});
