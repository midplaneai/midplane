import { describe, expect, it } from "vitest";

import {
  TOKEN_REGEX,
  generateToken,
  parseToken,
  validateChecksum,
} from "../src/token-format.ts";

describe("generateToken", () => {
  it("produces a token matching the public regex (live env)", () => {
    const { plaintext } = generateToken("live");
    expect(TOKEN_REGEX.test(plaintext)).toBe(true);
    expect(plaintext.startsWith("mp_live_")).toBe(true);
    // 7 + 32 + 1 + 6 = 46 visible chars, plus the `_` between prefix and
    // entropy and between entropy and crc: 7 + 1 + 32 + 1 + 6 = 47.
    expect(plaintext.length).toBe(47);
  });

  it("produces a token matching the public regex (test env)", () => {
    const { plaintext, prefix } = generateToken("test");
    expect(TOKEN_REGEX.test(plaintext)).toBe(true);
    expect(prefix).toBe("mp_test");
    expect(plaintext.startsWith("mp_test_")).toBe(true);
  });

  it("returns last4 = last 4 chars of the entropy (NOT the trailing CRC)", () => {
    const { plaintext, last4 } = generateToken("live");
    const parsed = parseToken(plaintext)!;
    expect(last4).toBe(parsed.entropy.slice(-4));
    expect(last4).not.toBe(parsed.crc.slice(-4));
    // The plaintext's last 4 chars are CRC chars; last4 must differ.
    expect(last4).not.toBe(plaintext.slice(-4));
  });

  it("returns 10k distinct plaintexts (entropy sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      seen.add(generateToken("live").plaintext);
    }
    expect(seen.size).toBe(10000);
  });

  it("produces tokens whose CRC validates against their own entropy", () => {
    for (let i = 0; i < 32; i++) {
      const { plaintext } = generateToken(i % 2 === 0 ? "live" : "test");
      const parsed = parseToken(plaintext)!;
      expect(validateChecksum(parsed)).toBe(true);
    }
  });
});

describe("parseToken", () => {
  it("roundtrips with generateToken", () => {
    const { plaintext } = generateToken("live");
    const parsed = parseToken(plaintext);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe("mp_live");
    expect(parsed!.entropy).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed!.crc).toMatch(/^[0-9A-HJKMNP-Z]{6}$/);
    expect(`${parsed!.prefix}_${parsed!.entropy}_${parsed!.crc}`).toBe(
      plaintext,
    );
  });

  it("returns null on missing prefix", () => {
    expect(parseToken("live_" + "f".repeat(32) + "_ABCDEF")).toBeNull();
  });

  it("returns null on wrong env tag", () => {
    expect(parseToken("mp_prod_" + "f".repeat(32) + "_ABCDEF")).toBeNull();
  });

  it("returns null on uppercase hex entropy", () => {
    expect(parseToken("mp_live_" + "F".repeat(32) + "_ABCDEF")).toBeNull();
  });

  it("returns null on short entropy", () => {
    expect(parseToken("mp_live_" + "f".repeat(31) + "_ABCDEF")).toBeNull();
  });

  it("returns null on long entropy", () => {
    expect(parseToken("mp_live_" + "f".repeat(33) + "_ABCDEF")).toBeNull();
  });

  it("returns null when the CRC uses a banned Crockford char (I)", () => {
    // Regex predates checksum validation — banned alphabet chars never
    // make it past the parse stage. Same for L / O / U; one example
    // suffices to assert the alphabet contract.
    expect(parseToken("mp_live_" + "f".repeat(32) + "_IABCDE")).toBeNull();
  });

  it("returns null when the CRC is lowercase", () => {
    expect(parseToken("mp_live_" + "f".repeat(32) + "_abcdef")).toBeNull();
  });

  it("returns null on non-string input", () => {
    expect(parseToken(null)).toBeNull();
    expect(parseToken(undefined)).toBeNull();
    expect(parseToken(123)).toBeNull();
    expect(parseToken({})).toBeNull();
  });
});

describe("validateChecksum", () => {
  it("accepts a freshly generated token", () => {
    const { plaintext } = generateToken("live");
    const parsed = parseToken(plaintext)!;
    expect(validateChecksum(parsed)).toBe(true);
  });

  it("rejects a token whose CRC was bit-flipped", () => {
    const { plaintext } = generateToken("live");
    const parsed = parseToken(plaintext)!;
    // Flip the first CRC char to a different valid Crockford char.
    const swap = parsed.crc[0] === "0" ? "1" : "0";
    const flipped = swap + parsed.crc.slice(1);
    expect(validateChecksum({ ...parsed, crc: flipped })).toBe(false);
  });

  it("rejects a token whose entropy was tampered with (CRC stale)", () => {
    const { plaintext } = generateToken("live");
    const parsed = parseToken(plaintext)!;
    const swap = parsed.entropy[0] === "0" ? "1" : "0";
    const tampered = swap + parsed.entropy.slice(1);
    expect(validateChecksum({ ...parsed, entropy: tampered })).toBe(false);
  });
});
