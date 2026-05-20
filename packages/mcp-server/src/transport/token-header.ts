// X-Midplane-Token-Id header parser.
//
// The cloud proxy injects this header on every forwarded MCP request,
// naming the cloud-side token that opened the session. The engine reads it
// once at the MCP `initialize` handshake, caches it on the session, and
// stamps it on every audit row the session emits — answering the cloud-side
// "which token ran this query?" audit question.
//
// Tolerance contract (per per-token attribution spec):
//   - Header is HEADER-ONLY: no fallback to _meta or SQL comments.
//   - Format: 26-char Crockford base32 ULID (^[0-9A-HJKMNP-TV-Z]{26}$).
//   - If present but malformed, IGNORE — return null. NEVER reject the
//     request: the engine must remain tolerant of clients that send junk.
//   - Defensive 64-char cap before any storage to bound pathological input.
//   - Absent → null (the session simply has no token attribution).
//
// `mcp_token_id` flows through `EngineContext` and lands in the audit row's
// nullable column of the same name. Stays NULL for the session lifetime when
// the initialize request didn't carry a valid header.

import type { IncomingHttpHeaders } from "node:http";

export const TOKEN_ID_HEADER = "x-midplane-token-id";

// Hard cap before any validation runs. ULIDs are 26 chars; the cap is
// purely defensive (a hostile client sending a 4 MB header should be
// dropped on the floor, not regex-tested).
const MAX_HEADER_LEN = 64;

// Crockford base32 ULID — uppercase letters and digits, no I/L/O/U.
// Lowercase is intentionally NOT accepted: the proxy sends uppercase and
// any lowercase value indicates a misbehaving (or impersonating) client.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Returns the token id when the header was present and a well-formed ULID;
// null in every other case (absent, blank, too long, not a ULID, array of
// values). Never throws — the engine ignores junk and never blocks on it.
export function parseMcpTokenIdHeader(
  headers: IncomingHttpHeaders | undefined,
): string | null {
  if (!headers) return null;
  const raw = headers[TOKEN_ID_HEADER];
  if (raw === undefined) return null;
  // node:http surfaces duplicated headers as a string[]. Per the spec
  // there's only ever one X-Midplane-Token-Id per request; an array
  // indicates a misbehaving intermediary and we IGNORE rather than pick
  // one (picking the first would be a footgun if an attacker can inject
  // a second value).
  if (Array.isArray(raw)) return null;
  if (typeof raw !== "string") return null;
  // Cap BEFORE any further processing so a pathological 4 MB header
  // never reaches the regex engine.
  if (raw.length > MAX_HEADER_LEN) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!ULID_RE.test(trimmed)) return null;
  return trimmed;
}
