import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { assertBootEnv } from "../src/lib/assert-boot-env.ts";

const PEPPER_B64 = randomBytes(32).toString("base64");
const KEY_HEX = randomBytes(32).toString("hex");

function envMode(region: "eu" | "us"): Record<string, string | undefined> {
  const upper = region.toUpperCase();
  return {
    MIDPLANE_REGION: region,
    MIDPLANE_KMS_MODE: "env",
    [`DATABASE_URL_${upper}`]: "postgres://localhost/x",
    [`MIDPLANE_KMS_DEV_KEY_${upper}`]: KEY_HEX,
    [`MIDPLANE_TOKEN_PEPPER_${upper}_V1`]: PEPPER_B64,
  };
}

describe("assertBootEnv", () => {
  it("passes on a complete env-mode EU env", () => {
    expect(() => assertBootEnv(envMode("eu"))).not.toThrow();
  });

  it("passes on a complete env-mode US env", () => {
    expect(() => assertBootEnv(envMode("us"))).not.toThrow();
  });

  it("throws when MIDPLANE_REGION is missing", () => {
    expect(() => assertBootEnv({})).toThrow(/MIDPLANE_REGION/);
  });

  it("throws when MIDPLANE_REGION is neither eu nor us", () => {
    expect(() =>
      assertBootEnv({ MIDPLANE_REGION: "apac" }),
    ).toThrow(/MIDPLANE_REGION.*"apac"/);
  });

  it("reports the pepper var as missing when only it is unset", () => {
    const env = envMode("eu");
    delete env.MIDPLANE_TOKEN_PEPPER_EU_V1;
    expect(() => assertBootEnv(env)).toThrow(
      /MIDPLANE_TOKEN_PEPPER_EU_V1/,
    );
  });

  it("reports the DB url as missing when only it is unset", () => {
    const env = envMode("eu");
    delete env.DATABASE_URL_EU;
    expect(() => assertBootEnv(env)).toThrow(/DATABASE_URL_EU/);
  });

  it("collects multiple issues into a single error", () => {
    const env: Record<string, string | undefined> = { MIDPLANE_REGION: "eu" };
    let err: Error | null = null;
    try {
      assertBootEnv(env);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/DATABASE_URL_EU/);
    expect(err!.message).toMatch(/MIDPLANE_KMS_DEV_KEY_EU/);
    expect(err!.message).toMatch(/MIDPLANE_TOKEN_PEPPER_EU_V1/);
    expect(err!.message).toMatch(/3 issues/);
  });

  it("skips derived-var checks when region itself is invalid", () => {
    let err: Error | null = null;
    try {
      assertBootEnv({});
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toMatch(/MIDPLANE_REGION/);
    // Don't drown the user in derived-var noise when the root cause
    // is the region itself.
    expect(err!.message).not.toMatch(/DATABASE_URL/);
    expect(err!.message).not.toMatch(/TOKEN_PEPPER/);
  });

  it("checks kms-mode vars when MIDPLANE_KMS_MODE=kms", () => {
    const env: Record<string, string | undefined> = {
      MIDPLANE_REGION: "eu",
      MIDPLANE_KMS_MODE: "kms",
      DATABASE_URL_EU: "postgres://localhost/x",
    };
    expect(() => assertBootEnv(env)).toThrow(/MIDPLANE_KMS_KEY_EU/);
    expect(() => assertBootEnv(env)).toThrow(
      /MIDPLANE_TOKEN_PEPPER_CT_EU_V1/,
    );
  });

  it("passes on a complete kms-mode env", () => {
    const env: Record<string, string | undefined> = {
      MIDPLANE_REGION: "eu",
      MIDPLANE_KMS_MODE: "kms",
      DATABASE_URL_EU: "postgres://localhost/x",
      MIDPLANE_KMS_KEY_EU: "arn:aws:kms:eu-central-1:...:key/abc",
      MIDPLANE_TOKEN_PEPPER_CT_EU_V1: "base64ciphertext==",
    };
    expect(() => assertBootEnv(env)).not.toThrow();
  });

  it("rejects an unknown KMS mode", () => {
    const env = envMode("eu");
    env.MIDPLANE_KMS_MODE = "hsm";
    expect(() => assertBootEnv(env)).toThrow(/MIDPLANE_KMS_MODE/);
  });

  it("flags INDEXER_TOKEN when FLY_API_TOKEN is set without it", () => {
    const env = envMode("eu");
    env.FLY_API_TOKEN = "fly_token";
    expect(() => assertBootEnv(env)).toThrow(/INDEXER_TOKEN/);
  });

  it("does not require INDEXER_TOKEN on a laptop (no FLY_API_TOKEN)", () => {
    expect(() => assertBootEnv(envMode("eu"))).not.toThrow();
  });

  describe("self-host (MIDPLANE_SELF_HOST=1)", () => {
    function selfHostEnv(): Record<string, string | undefined> {
      return {
        MIDPLANE_SELF_HOST: "1",
        DATABASE_URL: "postgres://localhost/x",
        MIDPLANE_KMS_MODE: "env",
        MIDPLANE_KMS_DEV_KEY_EU: KEY_HEX,
        MIDPLANE_TOKEN_PEPPER_EU_V1: PEPPER_B64,
      };
    }

    it("passes on a complete self-host env", () => {
      expect(() => assertBootEnv(selfHostEnv())).not.toThrow();
    });

    it("does NOT require the cloud per-region / region-pin vars", () => {
      // No MIDPLANE_REGION, no DATABASE_URL_EU/US — self-host pins the region.
      const env = selfHostEnv();
      expect(env.MIDPLANE_REGION).toBeUndefined();
      expect(env.DATABASE_URL_EU).toBeUndefined();
      expect(() => assertBootEnv(env)).not.toThrow();
    });

    it("requires DATABASE_URL (the single Postgres)", () => {
      const env = selfHostEnv();
      delete env.DATABASE_URL;
      expect(() => assertBootEnv(env)).toThrow(/DATABASE_URL\b/);
    });

    it("requires the env-mode key + pepper for the pinned region", () => {
      const env = selfHostEnv();
      delete env.MIDPLANE_KMS_DEV_KEY_EU;
      delete env.MIDPLANE_TOKEN_PEPPER_EU_V1;
      expect(() => assertBootEnv(env)).toThrow(/MIDPLANE_KMS_DEV_KEY_EU/);
      expect(() => assertBootEnv(env)).toThrow(/MIDPLANE_TOKEN_PEPPER_EU_V1/);
    });

    it("rejects kms mode (no AWS in self-host)", () => {
      const env = selfHostEnv();
      env.MIDPLANE_KMS_MODE = "kms";
      expect(() => assertBootEnv(env)).toThrow(/MIDPLANE_KMS_MODE/);
    });
  });
});
