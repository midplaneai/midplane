import { beforeAll, describe, expect, it } from "vitest";

import {
  otherRegion,
  signEmailHint,
  verifyEmailHint,
} from "../src/lib/region-routing";

beforeAll(() => {
  // signEmailHint/verifyEmailHint HMAC with the shared region secret.
  process.env.MIDPLANE_REGION_COOKIE_SECRET =
    "test-secret-at-least-32-bytes-long-aaaaaaaa";
});

describe("otherRegion", () => {
  it("flips to the other region", () => {
    expect(otherRegion("eu")).toBe("us");
    expect(otherRegion("us")).toBe("eu");
  });
});

describe("email hint token", () => {
  it("roundtrips the email verbatim (case preserved for prefill)", async () => {
    const token = await signEmailHint("Alice@Example.com", 1000);
    expect(await verifyEmailHint(token, 1000)).toBe("Alice@Example.com");
  });

  it("honors the 10-minute expiry", async () => {
    const token = await signEmailHint("a@b.com", 1000); // exp = 1600
    expect(await verifyEmailHint(token, 1599)).toBe("a@b.com");
    expect(await verifyEmailHint(token, 1601)).toBeNull();
  });

  it("rejects a tampered email (signature won't match)", async () => {
    const token = await signEmailHint("a@b.com", 1000);
    const [, exp, sig] = token.split(".");
    const forgedEmail = Buffer.from("evil@b.com").toString("base64url");
    expect(await verifyEmailHint(`${forgedEmail}.${exp}.${sig}`, 1000)).toBeNull();
  });

  it("rejects malformed / empty input", async () => {
    expect(await verifyEmailHint(undefined, 1000)).toBeNull();
    expect(await verifyEmailHint("", 1000)).toBeNull();
    expect(await verifyEmailHint("a.b", 1000)).toBeNull();
    expect(await verifyEmailHint("a.b.c.d", 1000)).toBeNull();
  });
});
