// Loopback-equivalence matching for MCP OAuth redirect URIs.
//
// Why this exists: Next.js 15's `parseURL` (next-url.ts, REGEX_LOCALHOST_HOSTNAME)
// string-replaces the FIRST `127.x.x.x` / `[::1]` / `localhost` substring
// anywhere in the request URL with `localhost` — including inside the
// percent-encoded `redirect_uri` query value. In production the server binds
// 0.0.0.0, so nothing before the query absorbs the (non-global) replace and a
// native client's RFC 8252 loopback redirect (`http://127.0.0.1:33418/`, what
// VS Code registers and sends) reaches Better Auth as `http://localhost:33418/`.
// Better Auth exact-matches against the registered list → "Invalid redirect
// URI". Dev never shows it: there the request host is `localhost:3000`, which
// soaks up the single replace. Fixed upstream in Next 16 (anchored, parsed-
// hostname-only), but the equivalence below is correct to keep regardless —
// RFC 8252 §7.3 treats the loopback interface's names as interchangeable.
//
// The rule: a requested loopback redirect may stand in for a REGISTERED
// loopback redirect when scheme, port, path, and query all match and only the
// loopback host spelling differs (localhost ↔ 127.0.0.0/8 ↔ [::1]). We then
// substitute the REGISTERED string, so everything downstream — the stored
// verification value, the consent redirect, and the token-exchange comparison
// (the client re-sends ITS original form in the token POST body, which Next
// never touches) — agrees with what the client actually listens on.
//
// Deliberately NOT covered here: RFC 8252's any-port loopback matching (VS
// Code falls back to a random port when 33418 is busy). Substituting a
// different port would redirect the browser somewhere the client isn't
// listening; supporting that means teaching the matcher itself, i.e. an
// upstream Better Auth change, not a rewrite.

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  // WHATWG URL keeps the brackets on IPv6 hostnames; accept both spellings.
  if (hostname === "[::1]" || hostname === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

/** True when `uri` parses and its host is a loopback name/literal — the only
 *  case where the equivalence lookup (and its DB read) is worth doing. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    return isLoopbackHostname(new URL(uri).hostname);
  } catch {
    return false;
  }
}

/** The one adapter call the repair needs — structurally satisfied by Better
 *  Auth's Adapter, so the hook passes `ctx.context.adapter` straight through
 *  and tests can pass the same instance. */
interface ClientLookup {
  findOne<T>(args: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<T | null>;
}

/** Authorize-hook entry point: given the /mcp/authorize query, return the
 *  repaired redirect_uri (the registered string a corrupted loopback URI is
 *  equivalent to), or undefined when nothing needs changing — exact matches,
 *  non-loopback URIs, unknown clients, and malformed input all fall through
 *  untouched so the plugin's own validation stays the deciding authority. */
export async function repairedLoopbackRedirect(
  query: Record<string, unknown> | undefined,
  adapter: ClientLookup,
): Promise<string | undefined> {
  const requested =
    typeof query?.redirect_uri === "string" ? query.redirect_uri : undefined;
  const clientId =
    typeof query?.client_id === "string" ? query.client_id : undefined;
  // The client-row read runs only for loopback URIs (native clients), so the
  // common https flows (Claude, ChatGPT) pay nothing extra.
  if (!requested || !clientId || !isLoopbackRedirect(requested)) {
    return undefined;
  }
  const client = await adapter.findOne<{ redirectUrls: string }>({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
  });
  const registered = client?.redirectUrls?.split(",") ?? [];
  if (registered.length === 0 || registered.includes(requested)) {
    return undefined;
  }
  return loopbackEquivalentRedirect(requested, registered) ?? undefined;
}

/** Find the registered redirect URI the requested one is loopback-equivalent
 *  to: same scheme, port, path, and query — only the loopback host spelling
 *  differs. Returns the REGISTERED string (the exact form Better Auth's
 *  matcher expects), or null when no equivalent exists. Callers should try an
 *  exact match first; this is the fallback. */
export function loopbackEquivalentRedirect(
  requested: string,
  registered: string[],
): string | null {
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(req.hostname)) return null;

  for (const candidate of registered) {
    let reg: URL;
    try {
      reg = new URL(candidate);
    } catch {
      continue;
    }
    if (!isLoopbackHostname(reg.hostname)) continue;
    if (reg.protocol !== req.protocol) continue;
    if (reg.port !== req.port) continue;
    if (reg.pathname !== req.pathname) continue;
    if (reg.search !== req.search) continue;
    return candidate;
  }
  return null;
}
