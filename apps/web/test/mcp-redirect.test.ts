// Regression coverage for the MCP OAuth loopback-redirect repair
// (lib/mcp-redirect.ts + the /mcp/authorize before-hook in lib/auth.ts).
//
// Background: Next 15's parseURL string-replaces the first loopback-looking
// substring in the request URL with `localhost` — in production (host
// 0.0.0.0) that lands INSIDE the percent-encoded redirect_uri, so VS Code's
// RFC 8252 `http://127.0.0.1:33418/` reached Better Auth as
// `http://localhost:33418/` and failed the exact-string match ("Invalid
// redirect URI"). The integration block reproduces that corrupted request
// against a real Better Auth instance and proves the repair hook turns the
// 400 back into the consent redirect.

import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import {
  isLoopbackRedirect,
  loopbackEquivalentRedirect,
  repairedLoopbackRedirect,
} from "../src/lib/mcp-redirect.ts";

// VS Code's actual DCR registration list (observed in prod, 2026-07-23).
const VSCODE_REDIRECTS = [
  "https://insiders.vscode.dev/redirect",
  "https://vscode.dev/redirect",
  "http://127.0.0.1/",
  "http://127.0.0.1:33418/",
];

describe("isLoopbackRedirect", () => {
  it("accepts localhost, 127.0.0.0/8, and [::1]", () => {
    expect(isLoopbackRedirect("http://localhost:3000/cb")).toBe(true);
    expect(isLoopbackRedirect("http://127.0.0.1:33418/")).toBe(true);
    expect(isLoopbackRedirect("http://127.5.5.5/cb")).toBe(true);
    expect(isLoopbackRedirect("http://[::1]:8080/")).toBe(true);
  });

  it("rejects public hosts, out-of-range octets, and non-URLs", () => {
    expect(isLoopbackRedirect("https://vscode.dev/redirect")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.256/")).toBe(false);
    expect(isLoopbackRedirect("http://1270.0.0.1/")).toBe(false);
    expect(isLoopbackRedirect("not a url")).toBe(false);
  });
});

describe("loopbackEquivalentRedirect", () => {
  it("maps the Next-corrupted localhost form back to the registered 127.0.0.1 form", () => {
    expect(
      loopbackEquivalentRedirect("http://localhost:33418/", VSCODE_REDIRECTS),
    ).toBe("http://127.0.0.1:33418/");
    expect(
      loopbackEquivalentRedirect("http://localhost/", VSCODE_REDIRECTS),
    ).toBe("http://127.0.0.1/");
  });

  it("matches across loopback spellings, including [::1]", () => {
    expect(
      loopbackEquivalentRedirect("http://[::1]:33418/", VSCODE_REDIRECTS),
    ).toBe("http://127.0.0.1:33418/");
    expect(
      loopbackEquivalentRedirect("http://127.0.0.1:4000/cb", [
        "http://localhost:4000/cb",
      ]),
    ).toBe("http://localhost:4000/cb");
  });

  it("requires scheme, port, path, and query to match exactly", () => {
    // Port differs — RFC 8252 any-port matching is deliberately NOT done here
    // (substituting a port would redirect where the client isn't listening).
    expect(
      loopbackEquivalentRedirect("http://localhost:9999/", VSCODE_REDIRECTS),
    ).toBeNull();
    // Scheme differs.
    expect(
      loopbackEquivalentRedirect("https://localhost:33418/", VSCODE_REDIRECTS),
    ).toBeNull();
    // Path differs.
    expect(
      loopbackEquivalentRedirect(
        "http://localhost:33418/other",
        VSCODE_REDIRECTS,
      ),
    ).toBeNull();
    // Query differs.
    expect(
      loopbackEquivalentRedirect("http://localhost:33418/?x=1", [
        "http://127.0.0.1:33418/",
      ]),
    ).toBeNull();
  });

  it("never maps to or from a non-loopback host", () => {
    // A public registered URI must not be reachable via host-swapping.
    expect(
      loopbackEquivalentRedirect("http://localhost/redirect", [
        "https://vscode.dev/redirect",
      ]),
    ).toBeNull();
    // A public requested URI is out of scope entirely.
    expect(
      loopbackEquivalentRedirect("https://evil.example/redirect", [
        "https://evil.example/redirect",
      ]),
    ).toBeNull();
  });
});

describe("repairedLoopbackRedirect", () => {
  // Hand-rolled instead of vi.fn(): the mock must keep findOne's generic
  // signature to satisfy ClientLookup, which vi.fn() erases to `unknown`.
  const adapterWith = (redirectUrls: string | null) => {
    const calls: unknown[] = [];
    return {
      calls,
      findOne: async <T,>(args: unknown): Promise<T | null> => {
        calls.push(args);
        return redirectUrls === null ? null : ({ redirectUrls } as T);
      },
    };
  };

  it("substitutes the registered form for a corrupted loopback URI", async () => {
    const adapter = adapterWith(VSCODE_REDIRECTS.join(","));
    await expect(
      repairedLoopbackRedirect(
        { client_id: "c1", redirect_uri: "http://localhost:33418/" },
        adapter,
      ),
    ).resolves.toBe("http://127.0.0.1:33418/");
  });

  it("leaves exact registered matches untouched", async () => {
    const adapter = adapterWith(VSCODE_REDIRECTS.join(","));
    await expect(
      repairedLoopbackRedirect(
        { client_id: "c1", redirect_uri: "http://127.0.0.1:33418/" },
        adapter,
      ),
    ).resolves.toBeUndefined();
  });

  it("skips the DB read entirely for non-loopback redirect URIs", async () => {
    const adapter = adapterWith(VSCODE_REDIRECTS.join(","));
    await expect(
      repairedLoopbackRedirect(
        { client_id: "c1", redirect_uri: "https://claude.ai/api/mcp/auth_callback" },
        adapter,
      ),
    ).resolves.toBeUndefined();
    expect(adapter.calls).toHaveLength(0);
  });

  it("does nothing for unknown clients or missing params", async () => {
    await expect(
      repairedLoopbackRedirect(
        { client_id: "ghost", redirect_uri: "http://localhost:33418/" },
        adapterWith(null),
      ),
    ).resolves.toBeUndefined();
    await expect(
      repairedLoopbackRedirect({}, adapterWith("http://127.0.0.1:33418/")),
    ).resolves.toBeUndefined();
  });
});

// End-to-end through a real Better Auth instance: DCR-register VS Code's
// redirect list, sign up, then authorize with the redirect_uri EXACTLY as the
// corrupted prod request delivers it. Mirrors the /mcp/authorize before-hook
// in lib/auth.ts (prompt=consent + scope⊇mcp + the loopback repair).
describe("mcp authorize with a Next-corrupted loopback redirect_uri", () => {
  async function buildAuth() {
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
          client_name: "vscode-test",
          redirect_uris: VSCODE_REDIRECTS,
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
      code_challenge: "W2CtSUKx4p33LAi_R1Gy_s-whKj2GWB4ZJKP61f5Dqk",
      code_challenge_method: "S256",
      scope: "openid profile email offline_access",
      redirect_uri: redirectUri,
      state: "s",
    });
    return `http://test.local/api/auth/mcp/authorize?${q}`;
  }

  it("corrupted localhost form reaches the consent page (the VS Code fix)", async () => {
    const { auth, clientId, cookie } = await buildAuth();
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://localhost:33418/"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/oauth/consent");
  });

  it("uncorrupted 127.0.0.1 form still works (the Next 16 world)", async () => {
    const { auth, clientId, cookie } = await buildAuth();
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://127.0.0.1:33418/"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/oauth/consent");
  });

  it("an unregistered loopback port is still rejected", async () => {
    const { auth, clientId, cookie } = await buildAuth();
    const res = await auth.handler(
      new Request(authorizeUrl(clientId, "http://localhost:9999/"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(400);
  });
});
