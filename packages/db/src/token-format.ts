// MCP token format helpers (PR1 of mcp_url_auth_security).
//
//   mp_live_<32 hex>_<6 char Crockford-base32 crc32>   <-- production
//   mp_test_<32 hex>_<6 char Crockford-base32 crc32>   <-- staging/dev
//
// 32 hex = 128 bits of entropy from crypto.getRandomValues. The 6-char
// Crockford-base32 CRC32 fingerprint lets the proxy reject malformed or
// typo'd tokens before any DB hit, and gives scanners (GitHub Secret
// Scanning Partner Program, GitGuardian, TruffleHog) a syntactic
// signature to match on.
//
// All exports are pure — no DB, no KMS, no IO. Safe to import from client
// components (this file lives next to policy.ts under the same client-safe
// subpath rule from CLAUDE.md). The HMAC hashing of the entropy at rest
// is a separate concern owned by packages/kms/src/pepper.ts.

import { timingSafeEqual } from "node:crypto";

/** Matches a fully-formed token. Capture groups: env ("live"|"test"),
 *  32-hex entropy, 6-char Crockford CRC. Designed so a single .exec call
 *  delivers everything `parseToken` needs. */
export const TOKEN_REGEX =
  /^mp_(live|test)_([0-9a-f]{32})_([0-9A-HJKMNP-Z]{6})$/;

// Crockford-base32 alphabet: digits 0-9 then A-Z minus I/L/O/U (to avoid
// confusion with 1/0 in eyes-on copy). Matches the character class in
// TOKEN_REGEX byte-for-byte.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface GeneratedToken {
  /** Full token string: `mp_(live|test)_<32 hex>_<6 base32>`. */
  plaintext: string;
  /** "mp_live" or "mp_test" — stored on the row for dashboard rendering
   *  and scanner identification. */
  prefix: string;
  /** Last 4 chars of the entropy portion (NOT the trailing CRC). Stored
   *  on the row so the dashboard can render "mp_live_…_a3f2" without
   *  retaining the plaintext anywhere after the show-once mint flow. */
  last4: string;
}

export interface ParsedToken {
  prefix: string;
  entropy: string;
  crc: string;
}

export function generateToken(env: "live" | "test"): GeneratedToken {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const entropy = Buffer.from(bytes).toString("hex"); // 32 hex chars
  const crc = encodeCrcCrockford(crc32(Buffer.from(entropy, "utf8")));
  const prefix = `mp_${env}`;
  return {
    plaintext: `${prefix}_${entropy}_${crc}`,
    prefix,
    last4: entropy.slice(-4),
  };
}

/** Parse a candidate string into its (prefix, entropy, crc) parts. Returns
 *  null on any structural mismatch — wrong prefix, wrong hex / base32
 *  alphabet, wrong length, or non-string input. Does NOT validate the
 *  checksum; call `validateChecksum` for that. */
export function parseToken(s: unknown): ParsedToken | null {
  if (typeof s !== "string") return null;
  const m = TOKEN_REGEX.exec(s);
  if (!m) return null;
  return {
    prefix: `mp_${m[1]}`,
    entropy: m[2]!,
    crc: m[3]!,
  };
}

/** Recompute the CRC over the entropy portion and compare in constant
 *  time. A CRC mismatch reveals nothing secret on its own — the entropy
 *  isn't a secret, just an identifier — but using timingSafeEqual
 *  everywhere is the simpler invariant than tracking which comparisons
 *  need it. Both sides are 6 ASCII chars by regex, so the lengths match
 *  and timingSafeEqual won't early-exit. */
export function validateChecksum(token: ParsedToken): boolean {
  const expected = encodeCrcCrockford(
    crc32(Buffer.from(token.entropy, "utf8")),
  );
  return timingSafeEqual(
    Buffer.from(token.crc, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

// --- internals --------------------------------------------------------------

// IEEE 802.3 CRC-32 (polynomial 0xEDB88320). Same algorithm zlib / Ethernet /
// PNG use. Single-byte lookup table for ~constant-time hot path.
const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c;
  }
  return tbl;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Encode the low 30 bits of `crc32val` as 6 Crockford-base32 chars,
// MSB-first. 6 chars × 5 bits = 30; the top 2 bits of the 32-bit CRC
// are dropped to fit the format budget. ~10^9 distinct values is plenty
// for typo detection (the CRC's role here, not crypto).
function encodeCrcCrockford(crc32val: number): string {
  const lower30 = crc32val & 0x3fffffff;
  let out = "";
  for (let i = 5; i >= 0; i--) {
    out += CROCKFORD[(lower30 >>> (i * 5)) & 0x1f]!;
  }
  return out;
}
