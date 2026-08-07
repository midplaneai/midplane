// Regression coverage for RFC 8252 §7.3 any-port loopback redirect URIs
// (lib/mcp-loopback-port.ts + the /mcp/authorize before-hook in lib/auth.ts).
//
// Background: native MCP clients register once via DCR and cache the client_id,
// but take a FRESH ephemeral port from the OS on every OAuth attempt. Observed
// in prod: Claude Code registered http://localhost:3118/callback and later
// requested http://localhost:54096/callback — same scheme, host, and path, only
// the port differs — and Better Auth's exact match 400s it ("Invalid redirect
// URI"). 21 of 41 oauth_application rows carry loopback redirect URIs, so this
// broke roughly half of all native clients permanently.
//
// The integration blocks drive a real Better Auth instance through the FULL
// flow — authorize, consent, token exchange — because the token leg is where a
// naive fix breaks: whatever authorize stores as the code's redirectURI must
// stay byte-identical to what the client re-sends in the token POST body.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import {
  reconciledRedirectUrls,
  reconcileLoopbackPortRegistration,
} from "../src/lib/mcp-loopback-port.ts";
import { repairedLoopbackRedirect } from "../src/lib/mcp-redirect.ts";

// What Claude Code registered in prod before its port went stale.
const CLAUDE_CODE_REGISTERED = "http://localhost:3118/callback";
// What it asked for on a later run.
const CLAUDE_CODE_REQUESTED = "http://localhost:54096/callback";

// VS Code's actual DCR registration list (observed in prod, 2026-07-23) — two
// https entries that must survive the rewrite untouched.
const VSCODE_REDIRECTS = [
  "https://insiders.vscode.dev/redirect",
  "https://vscode.dev/redirect",
  "http://127.0.0.1/",
  "http://127.0.0.1:33418/",
];

describe("reconciledRedirectUrls", () => {
  it("moves the stale loopback entry to the requested port", () => {
    expect(
      reconciledRedirectUrls(CLAUDE_CODE_REQUESTED, [CLAUDE_CODE_REGISTERED]),
    ).toEqual([CLAUDE_CODE_REQUESTED]);
  });

  it("replaces in place rather than appending, leaving other entries alone", () => {
    expect(
      reconciledRedirectUrls("http://127.0.0.1:54096/", VSCODE_REDIRECTS),
    ).toEqual([
      "https://insiders.vscode.dev/redirect",
      "https://vscode.dev/redirect",
      // `http://127.0.0.1/` is the first port-differing loopback match.
      "http://127.0.0.1:54096/",
      "http://127.0.0.1:33418/",
    ]);
  });

  it("matches across loopback host spellings", () => {
    expect(
      reconciledRedirectUrls("http://127.0.0.1:9000/cb", [
        "http://localhost:3118/cb",
      ]),
    ).toEqual(["http://127.0.0.1:9000/cb"]);
    expect(
      reconciledRedirectUrls("http://[::1]:9000/cb", [
        "http://localhost:3118/cb",
      ]),
    ).toEqual(["http://[::1]:9000/cb"]);
  });

  it("does nothing when the requested URI is already registered", () => {
    expect(
      reconciledRedirectUrls(CLAUDE_CODE_REGISTERED, [CLAUDE_CODE_REGISTERED]),
    ).toBeNull();
    expect(
      reconciledRedirectUrls("http://127.0.0.1:33418/", VSCODE_REDIRECTS),
    ).toBeNull();
  });

  it("does nothing when only the port matches — that is the spelling repair's job", () => {
    // Same port, different loopback spelling: lib/mcp-redirect.ts handles this
    // with a query rewrite and no write. Reconciling here would race it.
    expect(
      reconciledRedirectUrls("http://localhost:33418/", VSCODE_REDIRECTS),
    ).toBeNull();
  });

  // The guardrail that keeps this from becoming a real vulnerability: an https
  // redirect can point at a host the browser reaches over the network, so a
  // mismatched port there must stay rejected.
  it("never rewrites an https registration, even on a loopback host", () => {
    expect(
      reconciledRedirectUrls("https://localhost:9999/cb", [
        "https://localhost:3118/cb",
      ]),
    ).toBeNull();
    expect(
      reconciledRedirectUrls("http://localhost:9999/cb", [
        "https://localhost:3118/cb",
      ]),
    ).toBeNull();
    expect(
      reconciledRedirectUrls("https://localhost:9999/cb", [
        "http://localhost:3118/cb",
      ]),
    ).toBeNull();
  });

  it("never rewrites a non-loopback registration", () => {
    expect(
      reconciledRedirectUrls("http://localhost:9999/redirect", [
        "http://evil.example:3118/redirect",
      ]),
    ).toBeNull();
    // A public requested URI is out of scope entirely.
    expect(
      reconciledRedirectUrls("http://evil.example:9999/cb", [
        "http://localhost:3118/cb",
      ]),
    ).toBeNull();
  });

  it("requires path and query to match exactly", () => {
    expect(
      reconciledRedirectUrls("http://localhost:9999/other", [
        CLAUDE_CODE_REGISTERED,
      ]),
    ).toBeNull();
    expect(
      reconciledRedirectUrls("http://localhost:9999/callback?x=1", [
        CLAUDE_CODE_REGISTERED,
      ]),
    ).toBeNull();
  });

  it("rejects userinfo, fragments, commas, and malformed input", () => {
    // Neither userinfo nor a fragment belongs in an OAuth redirect URI, and
    // admitting them widens what counts as "differs only by port".
    expect(
      reconciledRedirectUrls("http://evil@localhost:9999/cb", [
        "http://localhost:3118/cb",
      ]),
    ).toBeNull();
    expect(
      reconciledRedirectUrls("http://localhost:9999/cb#x", [
        "http://localhost:3118/cb",
      ]),
    ).toBeNull();
    // Better Auth stores the list comma-joined; a comma would corrupt the row.
    expect(
      reconciledRedirectUrls("http://localhost:9999/a,b", [
        "http://localhost:3118/a,b",
      ]),
    ).toBeNull();
    expect(reconciledRedirectUrls("not a url", [CLAUDE_CODE_REGISTERED])).toBe(
      null,
    );
    expect(reconciledRedirectUrls(CLAUDE_CODE_REQUESTED, [])).toBeNull();
  });
});

describe("reconcileLoopbackPortRegistration", () => {
  // Hand-rolled instead of vi.fn(): the mock must keep findOne/update's generic
  // signatures to satisfy ClientRegistrationStore, which vi.fn() erases.
  const adapterWith = (redirectUrls: string | null) => {
    const updates: { redirectUrls: string }[] = [];
    const reads: unknown[] = [];
    return {
      updates,
      reads,
      findOne: async <T,>(args: unknown): Promise<T | null> => {
        reads.push(args);
        return redirectUrls === null ? null : ({ redirectUrls } as T);
      },
      update: async <T,>(args: {
        update: Record<string, unknown>;
      }): Promise<T | null> => {
        updates.push(args.update as { redirectUrls: string });
        return null;
      },
    };
  };

  it("writes the requested port back to the client row", async () => {
    const adapter = adapterWith(CLAUDE_CODE_REGISTERED);
    await reconcileLoopbackPortRegistration(
      { client_id: "c1", redirect_uri: CLAUDE_CODE_REQUESTED },
      adapter,
    );
    expect(adapter.updates).toEqual([{ redirectUrls: CLAUDE_CODE_REQUESTED }]);
  });

  it("does not write for an exact match", async () => {
    const adapter = adapterWith(VSCODE_REDIRECTS.join(","));
    await reconcileLoopbackPortRegistration(
      { client_id: "c1", redirect_uri: "http://127.0.0.1:33418/" },
      adapter,
    );
    expect(adapter.updates).toHaveLength(0);
  });

  it("skips the DB read entirely for non-loopback and https redirect URIs", async () => {
    const adapter = adapterWith(VSCODE_REDIRECTS.join(","));
    await reconcileLoopbackPortRegistration(
      { client_id: "c1", redirect_uri: "https://claude.ai/api/mcp/auth_callback" },
      adapter,
    );
    await reconcileLoopbackPortRegistration(
      { client_id: "c1", redirect_uri: "https://localhost:9999/cb" },
      adapter,
    );
    expect(adapter.reads).toHaveLength(0);
    expect(adapter.updates).toHaveLength(0);
  });

  it("does nothing for unknown clients or missing params", async () => {
    const ghost = adapterWith(null);
    await reconcileLoopbackPortRegistration(
      { client_id: "ghost", redirect_uri: CLAUDE_CODE_REQUESTED },
      ghost,
    );
    expect(ghost.updates).toHaveLength(0);

    const bare = adapterWith(CLAUDE_CODE_REGISTERED);
    await reconcileLoopbackPortRegistration({}, bare);
    expect(bare.reads).toHaveLength(0);
  });
});

// End-to-end through a real Better Auth instance, mirroring the /mcp/authorize
// before-hook in lib/auth.ts (prompt=consent + scope⊇mcp + the spelling repair +
// the any-port reconcile, in that order).
describe("mcp authorize with a fresh ephemeral port", () => {
  const VERIFIER = "midplane-any-port-verifier-0123456789abcdefghijklmno";
  const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

  async function buildAuth(redirectUris: string[]) {
    const auth = betterAuth({
      baseURL: "http://test.local",
      secret: "test-secret-test-secret-test-secret-1234",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        oauthApplication: [],
        oauthAccessToken: [],
        oauthConsent: [],
      }),
      emailAndPassword: { enabled: true },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/mcp/authorize") return;
          const scopes = new Set(
            String(ctx.query?.scope ?? "")
              .split(" ")
              .filter(Boolean),
          );
          scopes.add("mcp");
          const repaired = await repairedLoopbackRedirect(
            ctx.query,
            ctx.context.adapter,
          );
          if (!repaired) {
            await reconcileLoopbackPortRegistration(
              ctx.query,
              ctx.context.adapter,
            );
          }
          return {
            context: {
              ...ctx,
              query: {
                ...ctx.query,
                ...(repaired ? { redirect_uri: repaired } : {}),
                prompt: "consent",
                scope: Array.from(scopes).join(" "),
              },
            },
          };
        }),
      },
      plugins: [
        mcp({
          loginPage: "/sign-in",
          oidcConfig: {
            loginPage: "/sign-in",
            consentPage: "/oauth/consent",
            requirePKCE: true,
            scopes: ["mcp"],
          },
        }),
      ],
    });

    const reg = await auth.handler(
      new Request("http://test.local/api/auth/mcp/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "claude-code-test",
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    const signUp = await auth.handler(
      new Request("http://test.local/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://test.local",
        },
        body: JSON.stringify({
          name: "T",
          email: "t@example.com",
          password: "pw-123456789012",
        }),
      }),
    );
    const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0]!;
    return { auth, clientId, cookie };
  }

  function authorizeUrl(clientId: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "openid profile email offline_access",
      redirect_uri: redirectUri,
      state: "s",
    });
    return `http://test.local/api/auth/mcp/authorize?${q}`;
  }

  it("a stale registered port reaches the consent page (the Claude Code fix)", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      CLAUDE_CODE_REGISTERED,
    ]);
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, CLAUDE_CODE_REQUESTED), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/oauth/consent");
  });

  // The whole point of not rewriting the query: the code's stored redirectURI
  // must equal what the client re-sends in the token POST body. If they
  // disagree, authorize succeeds and the exchange fails — later and far less
  // legible than today's 400.
  it("completes the token exchange against the port the client actually sent", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      CLAUDE_CODE_REGISTERED,
    ]);

    const authorized = await auth.handler(
      new Request(authorizeUrl(clientId, CLAUDE_CODE_REQUESTED), {
        headers: { cookie },
      }),
    );
    expect(authorized.status).toBe(302);
    const consentCookie = (authorized.headers.get("set-cookie") ?? "")
      .split(";")[0]!;

    const consent = await auth.handler(
      new Request("http://test.local/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://test.local",
          cookie: `${cookie}; ${consentCookie}`,
        },
        body: JSON.stringify({ accept: true }),
      }),
    );
    expect(consent.status).toBe(200);
    const { redirectURI } = (await consent.json()) as { redirectURI: string };

    // The browser is sent to the LIVE port, not the stale registered one.
    expect(redirectURI.startsWith(`${CLAUDE_CODE_REQUESTED}?`)).toBe(true);
    const code = new URL(redirectURI).searchParams.get("code")!;
    expect(code).toBeTruthy();

    const token = await auth.handler(
      new Request("http://test.local/api/auth/mcp/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          // The client re-sends ITS OWN form, which nothing rewrites.
          redirect_uri: CLAUDE_CODE_REQUESTED,
          client_id: clientId,
          code_verifier: VERIFIER,
        }),
      }),
    );
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token?: string };
    expect(body.access_token).toBeTruthy();
  });

  // The path that forced this to be a write rather than a request-scoped
  // widening: when the user isn't signed in, the plugin stashes the query in a
  // cookie and re-enters authorize from a global AFTER hook on the sign-in
  // request, where our before hook never runs.
  it("survives the sign-in resume path", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      CLAUDE_CODE_REGISTERED,
    ]);

    // Unauthenticated authorize: bounces to /sign-in and sets the resume cookie.
    const bounced = await auth.handler(
      new Request(authorizeUrl(clientId, CLAUDE_CODE_REQUESTED)),
    );
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toContain("/sign-in");
    const resumeCookie = (bounced.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(resumeCookie).toContain("oidc_login_prompt");

    const signIn = await auth.handler(
      new Request("http://test.local/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://test.local",
          cookie: resumeCookie,
        },
        body: JSON.stringify({
          email: "t@example.com",
          password: "pw-123456789012",
        }),
      }),
    );
    // The resume lands on consent rather than 400ing on the stale port. It
    // reads the row the unauthenticated hit above already reconciled — which is
    // exactly why the widening has to be persisted.
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get("location")).toContain("/oauth/consent");
    expect(cookie).toBeTruthy();
  });

  it("an https redirect with a mismatched port is still rejected", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      "https://localhost:3118/callback",
    ]);
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "https://localhost:54096/callback"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("a non-loopback redirect with a mismatched port is still rejected", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      "http://evil.example:3118/callback",
    ]);
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://evil.example:54096/callback"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("a loopback redirect with a different PATH is still rejected", async () => {
    const { auth, clientId, cookie } = await buildAuth([
      CLAUDE_CODE_REGISTERED,
    ]);
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://localhost:54096/elsewhere"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(400);
  });
});
