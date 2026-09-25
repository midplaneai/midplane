// Strict base64url (RFC 4648 §5, no padding).
//
// Buffer.from(s, "base64url") is lenient: it skips characters outside the
// alphabet and ignores non-zero trailing bits, so two different strings can
// decode to the same bytes. Signed envelopes must have exactly one encoding per
// value — otherwise "same version, same bytes" comparisons and signature inputs
// stop meaning what they say — so decoding here rejects anything that doesn't
// round-trip.

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64url");
}

export function b64urlDecode(s: string): Buffer {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s) {
    throw new Error("non-canonical base64url");
  }
  return buf;
}
