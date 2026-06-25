// Streamable HTTP proxy core.
//
// Forwards a Next.js Request to a spawned OSS container running on
// http://<host>:<port>/mcp. Preserves headers (especially mcp-session-id
// and accept), method, body, and streams the response back so SSE-style
// notifications work without buffering.
//
// fly-replay note: the OSS transport sets `fly-replay: cache_key=<session>`
// on its responses for Fly's anycast session affinity. We proxy DIRECTLY to
// the per-token machine (registry → 6PN IP), so we don't need it — and we
// must STRIP it on the way out. Leaking it past the public Fly edge in front
// of THIS web app makes fly-proxy try to replay the client's request, loop,
// and bail with [PA02] "'fly-replay' response header was returned too many
// times" → 502. Session affinity is preserved by the registry, not the
// header. See STRIP_RESPONSE_HEADERS below.
//
// Multi-DB rollout (0008): one OSS container fronts N DBs. The proxy
// resolves the parent project + its children, decrypts each DSN
// independently (one DecryptCache entry per credential), then hands the
// full set to the spawner — which writes the multi-DB YAML and injects
// per-DB env vars.
//
// PR2 of mcp_url_auth_security (hybrid model):
//   - resolveByToken returns a token id alongside project+databases.
//   - The proxy injects `X-Midplane-Token-Id: <tokenId>` on the forwarded
//     request; OSS 0.6.0 session-freezes the value on MCP initialize and
//     stamps it on every emitted audit row.
//   - Last-used surface (last_used_at/_ip/_ua) is bumped fire-and-forget
//     with a 5-min debounce — the request must not block on this write
//     and must not fail because of it.

import { createHmac } from "node:crypto";

import {
  bumpLastUsed,
  resolveByToken,
  resolveOAuthProjectId,
  resolveProjectForCustomer,
  resolveScope,
  resolveSoleProjectId,
  scopeHeaderValue,
} from "@midplane-cloud/router";
import {
  customers,
  getDb,
  parseColumnMasksOrThrow,
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
  type Project,
  type ProjectDatabase,
  type Region,
} from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";
import { and, eq } from "drizzle-orm";

import { getMcpProxyContext } from "./mcp-proxy.ts";
import { bootRegion } from "./region-context.ts";
import { isSelfHost, SELF_HOST_CUSTOMER_ID } from "./self-host.ts";
import { ensureOAuthAttributionToken } from "./tokens.ts";

const HOP_BY_HOP = new Set([
  // The HTTP/1.1 hop-by-hop header (RFC 7230) — NOT the product "project"
  // concept; the rename sweep must never touch this literal.
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Engine response headers that must NOT reach the public Fly edge. fly-replay
// (+ fly-replay-src) are the engine app's internal anycast routing signals;
// the edge fronting this web app would act on them, loop, and return [PA02].
// We already hit the right machine directly, so they carry no value here.
const STRIP_RESPONSE_HEADERS = new Set(["fly-replay", "fly-replay-src"]);

// Build the client-facing headers from the engine's response: drop hop-by-hop
// headers and the Fly routing-control headers (see above), keep everything else
// (notably mcp-session-id and content-type for SSE). Exported so the stripping
// has a regression test without standing up the full proxy.
export function filterUpstreamResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of src) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE_HEADERS.has(lower)) continue;
    out.set(k, v);
  }
  return out;
}

// Build the headers forwarded to the engine from the client request: copy
// every non-hop-by-hop request header, then stamp the two Midplane control
// headers — for which the PROXY is the sole authority — OVER whatever the
// client sent. Exported so the trust-critical override has a regression test
// without standing up the full proxy.
//
//   X-Midplane-Token-Id: always set to our resolved attribution id. OSS 0.6.0
//     reads it at MCP initialize, session-freezes it, and stamps it on every
//     audit row (re-sends post-initialize are ignored). For the OAuth path it's
//     the (project, client) attribution row id, so audit attribution is
//     identical across auth methods. NEVER the plaintext token.
//
//   X-Midplane-Scope: the per-agent DB scope (P6.1). We delete any client value
//     first, then set ours ONLY when the credential carries a grant (scopeHeader
//     non-null). The engine narrows the session to the granted DBs + clamps
//     writes where read-only; absent (null) → unscoped (full access), preserving
//     every pre-scope session. Stripping the client value matters even though
//     scope only ever NARROWS — an unscoped credential must not be able to
//     smuggle a scope value to the engine. db-name keys are non-secret aliases.
export function buildForwardHeaders(
  src: Headers,
  opts: { tokenId: string; scopeHeader: string | null },
): Headers {
  const headers = new Headers();
  for (const [k, v] of src) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("X-Midplane-Token-Id", opts.tokenId);
  headers.delete("X-Midplane-Scope");
  if (opts.scopeHeader) headers.set("X-Midplane-Scope", opts.scopeHeader);
  return headers;
}

// Pepper map is loaded once per process and reused across requests. The
// kid → buffer table is required by resolveByToken (HMAC-SHA256 lookup
// per kid). We deliberately fetch lazily on first request rather than at
// module init so a test or dev process without the env var set can still
// import this module; the first request will surface the misconfig with
// the env-loader's own fail-fast message.
let pepperPromise: Promise<Map<string, Buffer>> | null = null;
function getPeppers(): Promise<Map<string, Buffer>> {
  if (!pepperPromise) {
    pepperPromise = loadPepperFromKms(bootRegion(), process.env);
  }
  return pepperPromise;
}

/** Truncate a client-supplied IP/UA before it lands on the row. The
 *  proxy is the trust boundary — a hostile agent can stuff arbitrary
 *  values here, so defensively cap each. The UA cap matches the
 *  router-side cap in bumpLastUsed; the IP cap matches the inet text
 *  representation upper bound (IPv6 with zone id). */
const MAX_IP_LEN = 64;

function extractIp(req: Request): string | null {
  // Prefer x-forwarded-for (Fly edge populates this with the customer
  // client IP) and fall back to x-real-ip. Both can contain a comma-
  // separated chain; take the leftmost (= original client) and trim.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, MAX_IP_LEN);
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.slice(0, MAX_IP_LEN);
  return null;
}

export async function proxyMcp(
  req: Request,
  token: string,
): Promise<Response> {
  // proxyMcp IS the production MCP ingress. Customer /mcp/<token> traffic
  // hits the web app here (eu/us.midplane.ai → midplane-web{,-us}); we
  // resolve the token, decrypt the DSN, spawn/reuse the OSS container, and
  // proxy to it over private 6PN. The engine apps (midplane-eu/us) only host
  // those private containers — they take no public MCP traffic. bootRegion()
  // pins this app's single region so the lookup hits the right (only) DB.
  const region = bootRegion();
  let peppers: Map<string, Buffer>;
  try {
    peppers = await getPeppers();
  } catch (err) {
    // Pepper misconfig is a deploy-time error, not a per-request one;
    // surface as a 500 with no token-existence information.
    console.error("[proxyMcp] pepper load failed", err);
    return Response.json(
      { ok: false, error: "service_misconfigured" },
      { status: 500 },
    );
  }

  const db = getDb(region);
  const resolved = await resolveByToken(db, token, region, peppers);
  if (!resolved.ok) {
    // Paused → distinct 403 so the agent (and our logs) can tell "owner
    // hit the kill switch" apart from a bad/unknown token (404). The token
    // and its URL are intact; resuming the project restores service.
    if (resolved.reason === "paused") {
      return Response.json(
        { ok: false, error: "project_paused" },
        { status: 403 },
      );
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  // Fire-and-forget last-used bump (HMAC path). The 5-min debounce predicate
  // lives in SQL so concurrent in-window requests collapse at the row level.
  // Errors are logged but never block / fail the forwarded request.
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  void bumpLastUsed(db, resolved.tokenId, ip, ua).catch((err) => {
    console.error("[proxyMcp] bumpLastUsed failed", err);
  });

  // Per-agent DB scope for a headless PAT (mcp_scope_grants keyed by token id).
  // No grant rows → empty → null header → full access: existing tokens are
  // grandfathered, and a token opts into a scope at creation. Grants present →
  // the engine narrows the session to them (+ read clamp).
  const scope = await resolveScope(
    db,
    { kind: "token", mcpTokenId: resolved.tokenId },
    resolved.databases,
  );

  return forwardResolved(req, {
    project: resolved.project,
    databases: resolved.databases,
    tokenId: resolved.tokenId,
    scopeHeader: scopeHeaderValue(scope),
  });
}

// Minimal structural view of the OAuth access-token record withMcpAuth passes
// to the handler (better-auth's oauthAccessToken row). We read only the three
// fields the proxy needs; userId can be null on the record's type so we guard.
export interface OAuthMcpSession {
  userId?: string | null;
  clientId?: string | null;
  scopes?: string | null;
}

// An OAuth bearer that passed withMcpAuth and the proxy's `mcp`-scope +
// customer-ownership gates: the authenticated subject the project-forward step
// needs. Returned by authenticateOAuth; consumed by forwardOAuthForProject.
interface AuthenticatedOAuth {
  region: Region;
  db: ReturnType<typeof getDb>;
  userId: string;
  clientId: string;
  customerId: string;
}

/** The shared OAuth front gate for BOTH ingress shapes (region-wide `/mcp` and
 *  the explicit `/mcp/<projectId>`). The bearer is already validated by
 *  withMcpAuth; here we (1) require both subject fields, (2) require the `mcp`
 *  capability scope, (3) map the user → their Midplane customer (tenant). On any
 *  failure it returns the ready-to-send Response; on success the authenticated
 *  subject. No project is touched yet — project selection differs per ingress. */
async function authenticateOAuth(
  session: OAuthMcpSession,
): Promise<{ ok: true; auth: AuthenticatedOAuth } | { ok: false; response: Response }> {
  const region = bootRegion();
  const db = getDb(region);

  const userId = session.userId ?? null;
  const clientId = session.clientId ?? null;
  if (!userId || !clientId) {
    // A well-formed access token always carries both; absence means a
    // malformed/forged record slipped through. Refuse without confirming any
    // project exists.
    return {
      ok: false,
      response: Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    };
  }

  // Scope gate. The bearer is valid (withMcpAuth), but validity alone is NOT
  // authorization to reach a database — a token minted for some other purpose
  // (a future OAuth-protected resource, or a client that requested only
  // openid/profile) must not grant MCP access. Require the `mcp` capability
  // scope before touching any project. Our authorize before-hook forces this
  // scope onto every flow we issue (lib/auth.ts), so compliant clients always
  // carry it; this check is the defense-in-depth that rejects tokens that don't.
  const scopes = new Set((session.scopes ?? "").split(" ").filter(Boolean));
  if (!scopes.has("mcp")) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "insufficient_scope" },
        {
          status: 403,
          headers: {
            "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="mcp"',
          },
        },
      ),
    };
  }

  const customerId = await resolveCustomerIdForUser(db, userId, region);
  if (!customerId) {
    // Authenticated user with no Midplane customer (e.g. signed up but never
    // picked a region). Nothing they can own — 403, not a project-probing
    // 404/401.
    return {
      ok: false,
      response: Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, auth: { region, db, userId, clientId, customerId } };
}

/** Resolve a project for an authenticated OAuth subject and forward. Shared by
 *  both ingress shapes once the project id is known (from the URL for the
 *  explicit form, from the credential's grant binding for the region-wide form):
 *    1. resolve the project ONLY if the customer owns it (else 404 / paused 403),
 *    2. mint-or-get the (project, client) attribution token so the engine still
 *       stamps a per-agent mcp_token_id on every audit row,
 *    3. resolve the per-agent DB scope (mcp_scope_grants keyed client + user),
 *    4. forward through the SAME spawn/forward core as the URL-token path. */
async function forwardOAuthForProject(
  req: Request,
  auth: AuthenticatedOAuth,
  projectId: string,
): Promise<Response> {
  const { db, userId, clientId } = auth;

  const resolved = await resolveProjectForCustomer(db, projectId, auth.customerId);
  if (!resolved.ok) {
    if (resolved.reason === "paused") {
      return Response.json(
        { ok: false, error: "project_paused" },
        { status: 403 },
      );
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Per-agent attribution: one mcp_tokens row per (project, OAuth client).
  // Its id is what the engine stamps as mcp_token_id — so the OAuth flow keeps
  // the SAME audit attribution shape the URL token had.
  const { id: tokenId, status: tokenStatus } = await ensureOAuthAttributionToken(
    db,
    {
      projectId: resolved.project.id,
      clientId,
      userId,
    },
  );

  // Revoking an interactive agent flips this attribution row to revoked. The
  // grant rows may still resolve a scope, so the row status is the enforcement
  // point — deny a revoked agent here, fail-closed, before any forward. The user
  // restores access by re-connecting (consent reactivates the row).
  if (tokenStatus !== "active") {
    return Response.json(
      { ok: false, error: "access_revoked" },
      {
        status: 403,
        headers: {
          "WWW-Authenticate":
            'Bearer error="invalid_token", error_description="this agent\'s access was revoked; re-connect to restore it"',
        },
      },
    );
  }

  // Last-used surface, same debounce as the URL path (forensics + dashboard
  // parity for the attribution row).
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  void bumpLastUsed(db, tokenId, ip, ua).catch((err) => {
    console.error("[proxyMcpOAuth] bumpLastUsed failed", err);
  });

  // Per-agent DB scope for the OAuth credential (mcp_scope_grants keyed by
  // client + user, written by the consent DB picker). Scope-on-the-credential
  // is the access boundary on top of ownership.
  const scope = await resolveScope(
    db,
    { kind: "oauth", clientId, userId },
    resolved.databases,
  );

  // No grant for any of this project's DBs → the user owns it but this agent
  // was approved for nothing here. Consent is FORCED on every authorize, and the
  // picker writes a grant per chosen DB, so an empty grant means "approved no
  // databases" → 403 (fail closed), not a project-probing 404. Self-host is
  // the exception: single-tenant, so an unscoped owner gets all their DBs (empty
  // → full access) rather than being locked out of their own data.
  if (scope.size === 0 && !isSelfHost()) {
    return Response.json(
      { ok: false, error: "no_database_grant" },
      {
        status: 403,
        headers: {
          "WWW-Authenticate":
            'Bearer error="insufficient_scope", error_description="no database access granted for this project; re-connect to choose databases"',
        },
      },
    );
  }

  return forwardResolved(req, {
    project: resolved.project,
    databases: resolved.databases,
    tokenId,
    scopeHeader: scopeHeaderValue(scope),
  });
}

/** MCP-OAuth ingress (explicit per-project): the agent presented an OAuth 2.1
 *  bearer (validated by withMcpAuth) and reached `/mcp/<projectId>`. The bearer
 *  authenticates the user + OAuth client; the PATH selects the project. The
 *  explicit address is the escape hatch for one client reaching several projects
 *  (distinct resource URLs → distinct registrations). Auth + ownership + scope
 *  are identical to the region-wide form. */
export async function proxyMcpOAuth(
  req: Request,
  projectId: string,
  session: OAuthMcpSession,
): Promise<Response> {
  const gate = await authenticateOAuth(session);
  if (!gate.ok) return gate.response;
  return forwardOAuthForProject(req, gate.auth, projectId);
}

/** MCP-OAuth ingress (region-wide, the default): the agent presented an OAuth
 *  2.1 bearer at `/mcp` — no project id in the URL. The project is the one the
 *  credential is bound to at consent (one OAuth credential → one project),
 *  derived from its grant set. No binding (the user approved the client but
 *  chose no project/databases, or never consented) → 403 with a re-connect
 *  hint, fail-closed, the same shape as an empty in-project grant. */
export async function proxyMcpOAuthGeneric(
  req: Request,
  session: OAuthMcpSession,
): Promise<Response> {
  const gate = await authenticateOAuth(session);
  if (!gate.ok) return gate.response;

  let projectId = await resolveOAuthProjectId(gate.auth.db, {
    clientId: gate.auth.clientId,
    userId: gate.auth.userId,
    customerId: gate.auth.customerId,
  });
  // Self-host single-tenant fallback: an owner who approved the client without
  // picking databases has no grant to derive the project from, but still gets
  // full access (the empty-scope exception in forwardOAuthForProject). When they
  // own exactly one project the intent is unambiguous — bind to it. Cloud never
  // reaches this: there consent forces a project + database choice.
  if (!projectId && isSelfHost()) {
    projectId = await resolveSoleProjectId(gate.auth.db, gate.auth.customerId);
  }
  if (!projectId) {
    return Response.json(
      { ok: false, error: "no_database_grant" },
      {
        status: 403,
        headers: {
          "WWW-Authenticate":
            'Bearer error="insufficient_scope", error_description="this connection is not bound to a project; re-connect to choose a project and its databases"',
        },
      },
    );
  }
  return forwardOAuthForProject(req, gate.auth, projectId);
}

/** Map an OAuth-authenticated user to the Midplane customer (tenant) they act
 *  as. Self-host: any authed user resolves to the single implicit customer
 *  (mirrors currentCustomer()). Cloud: the user's org → its customer, pinned to
 *  this regional DB. Returns null when the user has no customer yet. */
async function resolveCustomerIdForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  region: Region,
): Promise<string | null> {
  if (isSelfHost()) return SELF_HOST_CUSTOMER_ID;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(member, eq(member.organizationId, customers.orgId))
    .where(and(eq(member.userId, userId), eq(customers.region, region)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** The shared engine spawn + forward core, reached by BOTH the URL-token path
 *  (proxyMcp) and the OAuth path (proxyMcpOAuth) once a project + databases
 *  + attribution token id are resolved. Decrypts each DSN, validates policy at
 *  the boundary, spawns/reuses the container, forwards the Streamable HTTP
 *  request, and streams the filtered response back. The ONLY auth-method-
 *  specific input is the tokenId stamped on X-Midplane-Token-Id. */
async function forwardResolved(
  req: Request,
  resolved: {
    project: Project;
    databases: ProjectDatabase[];
    tokenId: string;
    // Pre-serialized X-Midplane-Scope value (db name → access), or null when
    // the credential is unscoped (full access). Resolved per-path by the
    // callers (PAT vs OAuth) so this shared core stays auth-method-agnostic.
    scopeHeader: string | null;
  },
): Promise<Response> {
  const { project, databases, tokenId, scopeHeader } = resolved;
  if (databases.length === 0) {
    // Project without children is a torn migration / data corruption —
    // can't spawn a container with no DSN. Treat as not_found to avoid
    // leaking the row's existence; the underlying issue surfaces in logs.
    // Log with tokenId only, never the plaintext token.
    console.error(
      `forwardResolved: project ${project.id} has no databases (tokenId=${tokenId})`,
    );
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const ctx = getMcpProxyContext();

  // Decrypt each child's DSN independently. Per-credential cache means
  // KMS unavailability for one DB doesn't block siblings; one expired
  // credential refuses the whole spawn (the OSS container needs every
  // configured DB to boot cleanly).
  const spawnDatabases = [];
  for (const cdb of databases) {
    const decrypt = await ctx.resolver.resolve({
      projectDatabase: cdb,
      region: project.region,
      customerId: project.customerId,
    });
    if (!decrypt.ok) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "credential_unavailable" },
          id: null,
        },
        { status: 503 },
      );
    }
    let tableAccess;
    let tenantScope;
    let guardrails;
    let columnMasks;
    try {
      // Validate at the boundary — Postgres should never hold malformed
      // policy (validatePolicy gates every write), but if it somehow does,
      // fail closed instead of starting a container with a degraded YAML.
      // parseTenantScopeOrThrow normalizes legacy 0.4.x flat-map rows that
      // slipped past the 0012 backfill, so a pre-migration row reads as
      // { column: null, overrides: <old map>, exempt: [] }.
      // parseGuardrailsOrThrow resolves a null row (pre-0021) to the
      // default-ON posture, matching the engine's omitted-section default.
      // parseColumnMasksOrThrow resolves a null/legacy row (pre-masking) to
      // an empty map, so an unmasked DB serializes with no column_masks block.
      tableAccess = parsePolicyOrThrow(cdb.tableAccess);
      tenantScope = parseTenantScopeOrThrow(cdb.tenantScope);
      guardrails = parseGuardrailsOrThrow(cdb.guardrails);
      columnMasks = parseColumnMasksOrThrow(cdb.columnMasks);
    } catch (err) {
      console.error("invalid policy at spawn", err);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "upstream_unavailable" },
          id: null,
        },
        { status: 502 },
      );
    }
    spawnDatabases.push({
      name: cdb.name,
      projectDatabaseId: cdb.id,
      dsn: decrypt.plaintext,
      tableAccess,
      tenantScope,
      guardrails,
      columnMasks,
    });
  }

  // Masking salt (W1): when any database declares column_masks, derive a
  // per-project secret from the control-plane master (HMAC(master, projectId))
  // and inject it as MIDPLANE_MASK_SALT. One salt per engine (the engine takes
  // one salt for all its DBs); per-project keying means masked join-keys never
  // correlate across projects. Fail closed: masks declared but no master secret
  // configured means the engine would refuse to boot — refuse here with a clear
  // error instead of a cryptic spawn failure. No masks ⇒ no salt, no master
  // needed (unmasked projects are unaffected).
  const anyMasked = spawnDatabases.some(
    (d) => Object.keys(d.columnMasks).length > 0,
  );
  let maskSalt: string | undefined;
  if (anyMasked) {
    const master = process.env.MIDPLANE_MASK_SALT_MASTER;
    if (!master) {
      console.error(
        `forwardResolved: project ${project.id} has column_masks but MIDPLANE_MASK_SALT_MASTER is unset — refusing to spawn (masking would be unenforceable)`,
      );
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "upstream_unavailable" },
          id: null,
        },
        { status: 502 },
      );
    }
    maskSalt = createHmac("sha256", master).update(project.id).digest("hex");
  }

  let upstream;
  try {
    upstream = await ctx.registry.acquire({
      projectId: project.id,
      region: project.region,
      databases: spawnDatabases,
      maskSalt,
    });
  } catch (err) {
    console.error("spawn failed", err);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "upstream_unavailable" },
        id: null,
      },
      { status: 502 },
    );
  }

  const upstreamUrl = `http://${upstream.host}:${upstream.port}/mcp`;
  const headers = buildForwardHeaders(req.headers, { tokenId, scopeHeader });

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(upstreamUrl, init);
  } catch (err) {
    // Container may have been killed externally. Drop registry entry so the
    // next request respawns.
    await ctx.registry.invalidate(project.id).catch(() => undefined);
    console.error("proxy fetch failed", err);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32003, message: "upstream_disconnected" },
        id: null,
      },
      { status: 502 },
    );
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: filterUpstreamResponseHeaders(res.headers),
  });
}
