// X-Midplane-Scope header parser.
//
// The cloud proxy injects this header on every forwarded MCP request when the
// credential carries a per-agent DB scope (the consent picker for interactive
// agents, the token's scope for API tokens). The engine reads it ONCE at MCP
// `initialize`, caches it on the session, and applies it for the session's
// lifetime (see scope.ts) — exactly the read-once-and-freeze contract
// X-Midplane-Token-Id follows (token-header.ts).
//
// Wire format: a JSON object mapping engine DB name → "read" | "write":
//   X-Midplane-Scope: {"main":"read","analytics":"write"}
//
// Trust + tolerance contract:
//   - The header is set by the TRUSTED cloud proxy over the private 6PN network.
//     A hostile MCP client talks to the proxy, NEVER to the engine, so it can't
//     inject or strip this header. The proxy sends a well-formed header or none.
//   - ABSENT → null = "no scope" = full access. This is the deliberate path for
//     URL-token sessions, self-host owner-all, and OAuth sessions the proxy
//     chose to grant in full. null is reserved for this case ONLY.
//   - PRESENT + valid → a SessionScope map (>=1 entry in normal flow; the proxy
//     403s before forwarding when a credential has no grant for the connection).
//   - PRESENT + malformed → FAIL CLOSED: an empty map (scope active, zero DBs),
//     so a proxy bug surfaces as "no databases in scope" rather than silently
//     widening to full access. NEVER null for a malformed-but-present header.
//   - Defensive length cap before any JSON.parse.

import type { IncomingHttpHeaders } from "node:http";

import type { ScopeAccess, SessionScope } from "../scope.ts";

export const SCOPE_HEADER = "x-midplane-scope";

// Generous cap: ~45 bytes per DB entry, so 16 KB covers hundreds of DBs. Purely
// defensive against a pathological value reaching JSON.parse.
const MAX_HEADER_LEN = 16_384;

const ACCESS_VALUES = new Set<ScopeAccess>(["read", "write"]);
// Engine DB-name shape (mirrors config.ts DB_NAME_RE). Out-of-scope keys would
// just fail to intersect the registry, but validating keeps a malformed header
// from being treated as a valid grant.
const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// Returns null ONLY when the header is absent (= no scope = full access). When
// the header is present, returns a SessionScope map — empty on any malformation
// (fail closed). See the trust contract above.
export function parseMcpScopeHeader(
  headers: IncomingHttpHeaders | undefined,
): SessionScope | null {
  if (!headers) return null;
  const raw = headers[SCOPE_HEADER];
  if (raw === undefined) return null;
  // A duplicated header (string[]) is a misbehaving intermediary — fail closed
  // rather than pick one (picking would be a footgun if a value can be injected).
  if (Array.isArray(raw)) return new Map();
  if (typeof raw !== "string") return new Map();
  if (raw.length > MAX_HEADER_LEN) return new Map();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return new Map();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }

  const out: SessionScope = new Map();
  for (const [name, access] of Object.entries(parsed as Record<string, unknown>)) {
    // Any invalid entry voids the whole header (fail closed) — a partially
    // corrupt grant must never silently widen to "the valid part only".
    if (!DB_NAME_RE.test(name)) return new Map();
    if (typeof access !== "string" || !ACCESS_VALUES.has(access as ScopeAccess)) {
      return new Map();
    }
    out.set(name, access as ScopeAccess);
  }
  return out;
}
