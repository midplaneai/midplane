// RFC 8252 §7.3 any-port loopback redirect URIs for MCP OAuth.
//
// The problem: a native client (Claude Code, VS Code) registers ONCE via DCR,
// caches the `client_id` forever, but asks the OS for a fresh ephemeral port on
// every OAuth attempt. The redirect URI it registered on run 1
// (`http://localhost:3118/callback`) is therefore stale on run 2
// (`http://localhost:54096/callback`) and every run after. Better Auth
// exact-matches the requested URI against the registered list
// (`client.redirectUrls.find((url) => url === ctx.query.redirect_uri)` in the
// mcp plugin's authorize), so authorize 400s "Invalid redirect URI" — for good,
// not intermittently. RFC 8252 §7.3 says the authorization server MUST allow
// any port for a loopback redirect precisely because of this.
//
// Why this can't be a query rewrite (see lib/mcp-redirect.ts, which does the
// adjacent host-spelling repair): the plugin redirects the browser to whatever
// `ctx.query.redirect_uri` ends up being. Substituting the REGISTERED URI passes
// validation but points the browser at a dead port; substituting the REQUESTED
// URI keeps the browser right but still fails the plugin's exact match, because
// the match reads the registered list, not the query. The host-spelling repair
// works only because there the registered form IS what the client is listening
// on — untrue for a port change.
//
// So we widen the list itself: replace the one stale loopback entry with the
// requested URI before the plugin validates. The set of URIs the server will
// redirect to is exactly what compliant any-port matching allows — {registered
// loopback host} × {any port} — just reached statefully.
//
// Two consequences worth naming:
//
//  - This is a WRITE on a GET path, and `/mcp/authorize` runs our before-hook
//    ahead of its own session check, so it is reachable unauthenticated by
//    anyone holding a `client_id`. The blast radius is a nuisance, not an
//    escalation: the only thing an attacker can change is which loopback PORT
//    one client's registration names, the legitimate client rewrites it back on
//    its next attempt, and actually receiving a code at that port needs a local
//    listener — the same local-code-execution assumption RFC 8252 already
//    concedes when it mandates any-port matching. The narrow real cost is that
//    a flood could break one in-flight sign-in (the resume below re-reads the
//    row). Hence the hard scoping in `reconciledRedirectUrls`.
//  - It must be a write rather than a request-scoped widening because of the
//    login-resume path. When the user isn't signed in yet, the mcp plugin
//    stashes the query in the `oidc_login_prompt` cookie and re-enters
//    `authorizeMCPOAuth` from a global AFTER hook on the sign-in request — which
//    never dispatches `/mcp/authorize`, so our before hook does not run and any
//    in-memory widening would be gone. A persisted row survives it.
//
// The token exchange stays consistent for free: we never touch
// `ctx.query.redirect_uri`, so the value Better Auth stores as the code's
// `redirectURI` is byte-identical to what the client re-sends in the token POST
// body (which nothing rewrites), and its `value.redirectURI !== redirect_uri`
// check passes.

import { isLoopbackHostname } from "./mcp-redirect";

/** The two adapter calls the reconcile needs — structurally satisfied by Better
 *  Auth's Adapter, so the hook passes `ctx.context.adapter` straight through and
 *  tests can pass the same instance. */
interface ClientRegistrationStore {
  findOne<T>(args: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<T | null>;
  update<T>(args: {
    model: string;
    where: { field: string; value: string }[];
    update: Record<string, unknown>;
  }): Promise<T | null>;
}

/** A loopback redirect URI we are willing to treat as port-interchangeable.
 *  Everything outside this shape falls through untouched. */
function parseAnyPortCandidate(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // http only. This is the guardrail that keeps the widening from ever becoming
  // a real vulnerability: an https redirect can point at a host the browser
  // reaches over the network, so a mismatched port there must stay rejected.
  // RFC 8252 loopback redirects are http by construction.
  if (url.protocol !== "http:") return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  // Keep the equivalence class tight: no userinfo, no fragment. Neither belongs
  // in an OAuth redirect URI, and admitting them would widen what counts as
  // "differs only by port".
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  return url;
}

/** Given the requested redirect URI and a client's registered list, return the
 *  list with its one stale loopback entry REPLACED by `requested`, or null when
 *  nothing should change.
 *
 *  Replace rather than append so a client can't accumulate an unbounded set of
 *  live redirect targets across runs — at most one loopback port per registered
 *  loopback entry is ever valid. Non-loopback entries (VS Code registers two
 *  https ones) are carried through untouched.
 *
 *  A match requires: both URIs http, both hosts loopback, identical path and
 *  query, and a DIFFERENT port. Requiring the port to differ means this never
 *  competes with the host-spelling repair in lib/mcp-redirect.ts, which handles
 *  the same-port case and needs no write. */
export function reconciledRedirectUrls(
  requested: string,
  registered: string[],
): string[] | null {
  const req = parseAnyPortCandidate(requested);
  if (!req) return null;
  // We persist the REQUESTED string verbatim rather than the parsed URL's href,
  // because the token exchange compares against the exact bytes the client sent
  // (normalizing would drop a missing trailing slash and break it). That makes
  // the raw string durable state, so it has to be clean going in:
  //  - Comma: Better Auth stores the list comma-joined, so one would corrupt
  //    every entry after it.
  //  - Anything outside printable ASCII: WHATWG URL silently STRIPS leading and
  //    trailing control characters while parsing, so `…/cb\n` passes the checks
  //    above and would write a newline into the row. A loopback callback is
  //    always plain ASCII; anything else arrives percent-encoded.
  if (requested.includes(",")) return null;
  if (/[^!-~]/.test(requested)) return null;
  if (registered.includes(requested)) return null;

  // Host spelling must match EXACTLY — only the port may differ. Allowing
  // `127.0.0.1` to reconcile against a requested `localhost` would desync the
  // token exchange: under the Next loopback-host corruption that
  // lib/mcp-redirect.ts exists for, the query arrives spelled `localhost` while
  // the client's token POST body (which nothing rewrites) still says
  // `127.0.0.1`, and Better Auth compares those two byte-for-byte. Authorize
  // would succeed and the exchange would 401 — later and less legible than the
  // 400 this fixes — and the corrupted spelling would be persisted, breaking
  // every subsequent attempt too. Requiring equality means that combination
  // simply doesn't reconcile and degrades to the clean 400 instead.
  const sameShape = (reg: URL) =>
    reg.hostname === req.hostname &&
    reg.pathname === req.pathname &&
    reg.search === req.search;

  // If some registration already covers this port, the request is a pure
  // host-SPELLING mismatch and lib/mcp-redirect.ts repairs it with a query
  // rewrite and no write. Bail before searching for a port to move, so this
  // stays correct on its own rather than by virtue of the caller trying the
  // spelling repair first.
  const coveredAtThisPort = registered.some((candidate) => {
    const reg = parseAnyPortCandidate(candidate);
    return reg !== null && reg.port === req.port && sameShape(reg);
  });
  if (coveredAtThisPort) return null;

  const index = registered.findIndex((candidate) => {
    const reg = parseAnyPortCandidate(candidate);
    return reg !== null && reg.port !== req.port && sameShape(reg);
  });
  if (index === -1) return null;

  return registered.map((entry, i) => (i === index ? requested : entry));
}

/** Authorize-hook entry point: when the requested redirect_uri is a loopback URI
 *  that differs from one of the client's registered loopback URIs only by port,
 *  move that registration to the requested port so the plugin's exact match
 *  succeeds against the port the client is actually listening on.
 *
 *  Deliberately returns nothing — the query is left alone, which is what keeps
 *  the token exchange agreeing (see header). Unknown clients, non-loopback URIs,
 *  exact matches, and malformed input all no-op, leaving the plugin's own
 *  validation as the deciding authority. */
export async function reconcileLoopbackPortRegistration(
  query: Record<string, unknown> | undefined,
  adapter: ClientRegistrationStore,
): Promise<void> {
  const requested =
    typeof query?.redirect_uri === "string" ? query.redirect_uri : undefined;
  const clientId =
    typeof query?.client_id === "string" ? query.client_id : undefined;
  // Gate the client-row read on the cheap parse, so the common https flows
  // (Claude, ChatGPT) pay nothing extra.
  if (!requested || !clientId || !parseAnyPortCandidate(requested)) return;

  const client = await adapter.findOne<{ redirectUrls: string }>({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
  });
  const registered = client?.redirectUrls?.split(",") ?? [];
  if (registered.length === 0) return;

  const next = reconciledRedirectUrls(requested, registered);
  if (!next) return;

  await adapter.update({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
    update: { redirectUrls: next.join(",") },
  });
}
