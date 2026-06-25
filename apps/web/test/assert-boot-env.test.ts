import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { assertBootEnv } from "../src/lib/assert-boot-env.ts";

const PEPPER_B64 = randomBytes(32).toString("base64");
const KEY_HEX = randomBytes(32).toString("hex");
// 44-char base64 — clears the 32-char signing-secret floor.
const SECRET = randomBytes(32).toString("base64");

function envMode(region: "eu" | "us"): Record<string, string | undefined> {
  const upper = region.toUpperCase();
  return {
    MIDPLANE_REGION: region,
    MIDPLANE_KMS_MODE: "env",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: SECRET,
    MIDPLANE_REGION_COOKIE_SECRET: SECRET,
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
    expect(err!.message).toMatch(/BETTER_AUTH_URL/);
    expect(err!.message).toMatch(/BETTER_AUTH_SECRET/);
    expect(err!.message).toMatch(/MIDPLANE_REGION_COOKIE_SECRET/);
    expect(err!.message).toMatch(/6 issues/);
  });

  it("requires BETTER_AUTH_URL (the MCP OAuth issuer)", () => {
    const env = envMode("eu");
    delete env.BETTER_AUTH_URL;
    expect(() => assertBootEnv(env)).toThrow(/BETTER_AUTH_URL/);
  });

  describe("signing secrets (length-floored)", () => {
    it("requires BETTER_AUTH_SECRET (session signing)", () => {
      const env = envMode("eu");
      delete env.BETTER_AUTH_SECRET;
      expect(() => assertBootEnv(env)).toThrow(/BETTER_AUTH_SECRET/);
    });

    it("rejects a too-short BETTER_AUTH_SECRET", () => {
      const env = envMode("eu");
      env.BETTER_AUTH_SECRET = "short";
      expect(() => assertBootEnv(env)).toThrow(
        /BETTER_AUTH_SECRET.*too short/,
      );
    });

    it("requires MIDPLANE_REGION_COOKIE_SECRET (cloud region cookie HMAC)", () => {
      const env = envMode("eu");
      delete env.MIDPLANE_REGION_COOKIE_SECRET;
      expect(() => assertBootEnv(env)).toThrow(
        /MIDPLANE_REGION_COOKIE_SECRET/,
      );
    });

    it("rejects a too-short MIDPLANE_REGION_COOKIE_SECRET", () => {
      const env = envMode("eu");
      env.MIDPLANE_REGION_COOKIE_SECRET = "short";
      expect(() => assertBootEnv(env)).toThrow(
        /MIDPLANE_REGION_COOKIE_SECRET.*too short/,
      );
    });
  });

  describe("masking salt master (validate-if-set)", () => {
    it("passes when unset — masking is opt-in", () => {
      const env = envMode("eu");
      expect(env.MIDPLANE_MASK_SALT_MASTER).toBeUndefined();
      expect(() => assertBootEnv(env)).not.toThrow();
    });

    it("passes with a strong master set", () => {
      const env = { ...envMode("eu"), MIDPLANE_MASK_SALT_MASTER: KEY_HEX };
      expect(() => assertBootEnv(env)).not.toThrow();
    });

    it("rejects a too-short master when set (silent-footgun guard)", () => {
      const env = { ...envMode("eu"), MIDPLANE_MASK_SALT_MASTER: "short" };
      expect(() => assertBootEnv(env)).toThrow(
        /MIDPLANE_MASK_SALT_MASTER.*too short/,
      );
    });

    it("validates the master in self-host too", () => {
      const env: Record<string, string | undefined> = {
        MIDPLANE_SELF_HOST: "1",
        DATABASE_URL: "postgres://localhost/x",
        MIDPLANE_KMS_MODE: "env",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: SECRET,
        MIDPLANE_KMS_DEV_KEY_EU: KEY_HEX,
        MIDPLANE_TOKEN_PEPPER_EU_V1: PEPPER_B64,
        MIDPLANE_MASK_SALT_MASTER: "short",
      };
      expect(() => assertBootEnv(env)).toThrow(
        /MIDPLANE_MASK_SALT_MASTER.*too short/,
      );
    });
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
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: SECRET,
      MIDPLANE_REGION_COOKIE_SECRET: SECRET,
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

  describe("Stripe billing (cloud, all-or-nothing)", () => {
    const ALL_STRIPE = {
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRO_PRICE_ID: "price_pro",
      STRIPE_TEAM_PRICE_ID: "price_team",
    };

    it("passes with NO Stripe vars (billing off — keyless dev)", () => {
      expect(() => assertBootEnv(envMode("eu"))).not.toThrow();
    });

    it("passes with ALL four Stripe vars set", () => {
      expect(() =>
        assertBootEnv({ ...envMode("eu"), ...ALL_STRIPE }),
      ).not.toThrow();
    });

    it("flags the missing var(s) when the config is partial", () => {
      const env = { ...envMode("eu"), STRIPE_SECRET_KEY: "sk_test_x" };
      expect(() => assertBootEnv(env)).toThrow(/STRIPE_WEBHOOK_SECRET/);
      expect(() => assertBootEnv(env)).toThrow(/STRIPE_PRO_PRICE_ID/);
      expect(() => assertBootEnv(env)).toThrow(/STRIPE_TEAM_PRICE_ID/);
    });

    it("never requires Stripe vars in self-host", () => {
      const env: Record<string, string | undefined> = {
        MIDPLANE_SELF_HOST: "1",
        DATABASE_URL: "postgres://localhost/x",
        MIDPLANE_KMS_MODE: "env",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: SECRET,
        MIDPLANE_KMS_DEV_KEY_EU: KEY_HEX,
        MIDPLANE_TOKEN_PEPPER_EU_V1: PEPPER_B64,
        // A stray Stripe var must NOT pull in the all-or-nothing cloud check.
        STRIPE_SECRET_KEY: "sk_test_x",
      };
      expect(() => assertBootEnv(env)).not.toThrow();
    });
  });

  describe("self-host (MIDPLANE_SELF_HOST=1)", () => {
    function selfHostEnv(): Record<string, string | undefined> {
      return {
        MIDPLANE_SELF_HOST: "1",
        DATABASE_URL: "postgres://localhost/x",
        MIDPLANE_KMS_MODE: "env",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: SECRET,
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

    it("requires BETTER_AUTH_URL (the MCP OAuth issuer)", () => {
      const env = selfHostEnv();
      delete env.BETTER_AUTH_URL;
      expect(() => assertBootEnv(env)).toThrow(/BETTER_AUTH_URL/);
    });

    it("requires BETTER_AUTH_SECRET (sessions are signed in self-host too)", () => {
      const env = selfHostEnv();
      delete env.BETTER_AUTH_SECRET;
      expect(() => assertBootEnv(env)).toThrow(/BETTER_AUTH_SECRET/);
    });

    it("does NOT require MIDPLANE_REGION_COOKIE_SECRET (no region routing)", () => {
      // Self-host short-circuits region logic in middleware, so the region
      // cookie HMAC secret is never read.
      const env = selfHostEnv();
      expect(env.MIDPLANE_REGION_COOKIE_SECRET).toBeUndefined();
      expect(() => assertBootEnv(env)).not.toThrow();
    });
  });
});
