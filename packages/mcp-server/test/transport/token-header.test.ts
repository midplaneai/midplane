// Unit tests for the X-Midplane-Token-Id parser.
//
// Contract under test:
//   - well-formed ULID → returned verbatim
//   - missing / blank / wrong-shape → null (never throws)
//   - pathologically long → null (defensive cap before regex)
//   - duplicate header (array) → null
//   - never blocks the request: a malformed header is IGNORED, the
//     session simply has no token attribution.

import { describe, expect, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import {
  parseMcpTokenIdHeader,
  TOKEN_ID_HEADER,
} from "../../src/transport/token-header.ts";

const VALID_ULID = "01HZX3KQ7B9YV2RTNGH7MJSPVB";

function withHeader(value: string | string[] | undefined): IncomingHttpHeaders {
  return value === undefined ? {} : { [TOKEN_ID_HEADER]: value };
}

describe("parseMcpTokenIdHeader — happy path", () => {
  test("returns a well-formed Crockford base32 ULID verbatim", () => {
    expect(parseMcpTokenIdHeader(withHeader(VALID_ULID))).toBe(VALID_ULID);
  });

  test("trims surrounding whitespace before validating", () => {
    // The proxy shouldn't add whitespace, but tolerating a single space
    // is cheap defense against an intermediary that pads headers.
    expect(parseMcpTokenIdHeader(withHeader(`  ${VALID_ULID}  `))).toBe(
      VALID_ULID,
    );
  });

  test("the alphabet excludes I, L, O, U (Crockford)", () => {
    // Confirms our regex matches Crockford base32 and rejects ULIDs that
    // contain the four ambiguous letters.
    for (const bad of ["I", "L", "O", "U"]) {
      const malformed = VALID_ULID.slice(0, 25) + bad;
      expect(parseMcpTokenIdHeader(withHeader(malformed))).toBeNull();
    }
  });
});

describe("parseMcpTokenIdHeader — absent / blank", () => {
  test("returns null when the header is absent", () => {
    expect(parseMcpTokenIdHeader({})).toBeNull();
  });

  test("returns null on an empty headers object", () => {
    expect(parseMcpTokenIdHeader(withHeader(undefined))).toBeNull();
  });

  test("returns null when the headers arg itself is undefined", () => {
    expect(parseMcpTokenIdHeader(undefined)).toBeNull();
  });

  test("returns null on a blank-string value", () => {
    expect(parseMcpTokenIdHeader(withHeader(""))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("   "))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("\t\n"))).toBeNull();
  });
});

describe("parseMcpTokenIdHeader — malformed (IGNORE, never throw)", () => {
  test("returns null for a non-ULID string", () => {
    expect(parseMcpTokenIdHeader(withHeader("not-a-ulid"))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("12345"))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("Bearer abc"))).toBeNull();
  });

  test("returns null when length isn't exactly 26", () => {
    expect(parseMcpTokenIdHeader(withHeader(VALID_ULID.slice(0, 25)))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader(VALID_ULID + "X"))).toBeNull();
  });

  test("returns null on lowercase (proxy always sends uppercase)", () => {
    // Lowercase indicates a misbehaving (or impersonating) client; we
    // don't case-fold because doing so would also accept payloads from
    // an attacker who can't write proper ULIDs.
    expect(parseMcpTokenIdHeader(withHeader(VALID_ULID.toLowerCase()))).toBeNull();
  });

  test("returns null on an injection-shaped value", () => {
    // No SQLi/path-traversal/header-splitting concern in the engine
    // (the value lands in a parameterized INSERT), but the regex
    // rejects anything that isn't pure Crockford base32.
    expect(parseMcpTokenIdHeader(withHeader("01' OR '1'='1"))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("01\r\nX-Inject: 1"))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader("../../etc/passwd"))).toBeNull();
  });
});

describe("parseMcpTokenIdHeader — pathological input", () => {
  test("defensive 64-char cap: anything longer is dropped before regex", () => {
    // A hostile client sending a 4 MB header should be dropped on the
    // floor — never tested against the regex. We can't observe "regex
    // didn't run" directly, but we can observe that a long string of
    // valid-shaped characters still returns null (the cap fires first).
    const long = "0".repeat(100);
    expect(parseMcpTokenIdHeader(withHeader(long))).toBeNull();
  });

  test("returns null when node:http surfaces duplicate headers as an array", () => {
    // Multiple X-Midplane-Token-Id headers in one request → an array.
    // We refuse to pick one (picking first would be a footgun if an
    // attacker can inject a second header).
    expect(parseMcpTokenIdHeader(withHeader([VALID_ULID, VALID_ULID]))).toBeNull();
    expect(parseMcpTokenIdHeader(withHeader([VALID_ULID]))).toBeNull();
  });
});
