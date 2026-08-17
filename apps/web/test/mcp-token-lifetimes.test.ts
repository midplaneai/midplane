// Regression coverage for the MCP OAuth token lifetimes
// (lib/mcp-token-lifetimes.ts + the `mcp()` oidcConfig in lib/auth.ts).
//
// Background: the plugin's refreshTokenExpiresIn defaults to 7 days. An agent
// connected once and left idle past that comes back to a refresh that fails
// `invalid_grant`; the client invalidates its stored credentials and reports
// needsAuth. Observed in prod against Cursor, whose own log reads:
//
//   MCP OAuth SDK refresh catch branch
//   MCP OAuth refresh error
//   MCP OAuth credentials invalidated
//   Connect failed after auth_required; returning needsAuth (streamableHttp)
//
// The user sees a Midplane server with no tools and no explanation.
//
// This is asserted end-to-end rather than by reading the constant back, because
// the failure mode is a SILENT default: deleting the oidcConfig line leaves the
// build green, the types happy, and the flow working — only the stored expiry
// moves. The control block below pins that the plugin default really is 7 days,
// so this test fails loudly if a Better Auth upgrade changes the baseline out
// from under us rather than quietly agreeing with a stale assumption.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { mcp } from "better-auth/plugins";

import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
} from "../src/lib/mcp-token-lifetimes.ts";

const DAY_SECONDS = 60 * 60 * 24;
const PLUGIN_DEFAULT_REFRESH_SECONDS = 7 * DAY_SECONDS;

const VERIFIER = "midplane-token-lifetime-verifier-0123456789abcdefghij";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT_URI = "http://localhost:8787/callback";

interface TokenRow {
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
}

/** Runs the full authorize → consent → token-exchange flow against a real
 *  Better Auth instance and hands back both the token response and the row the
 *  plugin persisted. `oidcOverrides` empty = the plugin's own defaults, which is
 *  how the control block measures the baseline. */
async function issueTokens(oidcOverrides: {
  accessTokenExpiresIn?: number;
  refreshTokenExpiresIn?: number;
}) {
  const db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthApplication: [],
    oauthAccessToken: [] as TokenRow[],
    oauthConsent: [],
  };

  const auth = betterAuth({
    baseURL: "http://test.local",
    secret: "test-secret-test-secret-test-secret-1234",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [
      mcp({
        loginPage: "/sign-in",
        oidcConfig: {
          loginPage: "/sign-in",
          consentPage: "/oauth/consent",
          requirePKCE: true,
          scopes: ["mcp"],
          ...oidcOverrides,
        },
      }),
    ],
  });

  // Cursor's actual DCR shape: public client, fixed loopback callback.
  const reg = await auth.handler(
    new Request("http://test.local/api/auth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "cursor-test",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
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

  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    // offline_access is what makes the plugin mint a refresh token at all.
    scope: "openid profile email offline_access",
    redirect_uri: REDIRECT_URI,
    state: "s",
  });
  // No prompt=consent here. Production forces it in the /mcp/authorize
  // before-hook (lib/auth.ts) so the user always picks a project, but the
  // consent leg is upstream of what this test measures — skipping it keeps the
  // harness to the shortest path that still mints a real token pair.
  const authorized = await auth.handler(
    new Request(`http://test.local/api/auth/mcp/authorize?${query}`, {
      headers: { cookie },
    }),
  );
  expect(authorized.status).toBe(302);
  const code = new URL(
    authorized.headers.get("location")!,
  ).searchParams.get("code")!;
  expect(code).toBeTruthy();

  const issuedAt = Date.now();
  const token = await auth.handler(
    new Request("http://test.local/api/auth/mcp/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: VERIFIER,
      }),
    }),
  );
  expect(token.status).toBe(200);

  return {
    body: (await token.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    },
    row: db.oauthAccessToken.at(-1)!,
    issuedAt,
  };
}

/** Seconds between a persisted expiry and the moment the token was minted. */
function ttlSeconds(expiresAt: Date | undefined, issuedAt: number): number {
  return (new Date(expiresAt!).getTime() - issuedAt) / 1000;
}

describe("MCP OAuth token lifetimes", () => {
  it("keeps the idle window well clear of the plugin's 7-day default", () => {
    // The constant itself, so a careless edit to a smaller number is caught even
    // if the wiring below still passes.
    expect(MCP_REFRESH_TOKEN_TTL_SECONDS).toBe(90 * DAY_SECONDS);
    expect(MCP_REFRESH_TOKEN_TTL_SECONDS).toBeGreaterThan(
      PLUGIN_DEFAULT_REFRESH_SECONDS,
    );
    expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
  });

  it("issues a refresh token that survives a 90-day idle gap", async () => {
    const { body, row, issuedAt } = await issueTokens({
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
    });

    // offline_access must actually yield a refresh token — without one the
    // client re-prompts every hour when the access token lapses.
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);

    // The persisted expiry is what the refresh grant checks. Allow a generous
    // slop for clock/IO drift across the flow; we're separating 90 days from 7,
    // not measuring seconds.
    expect(
      ttlSeconds(row.refreshTokenExpiresAt, issuedAt),
    ).toBeGreaterThan(89 * DAY_SECONDS);
    expect(ttlSeconds(row.accessTokenExpiresAt, issuedAt)).toBeGreaterThan(
      MCP_ACCESS_TOKEN_TTL_SECONDS - 60,
    );
  });

  it("is actually wired into the mcp() oidcConfig in lib/auth.ts", () => {
    // Drift detector, same idea as infra/telemetry-proxy schema-mirror. The
    // blocks above prove the CONFIG produces a 90-day window, but they build
    // their own Better Auth instance — deleting the two lines from lib/auth.ts
    // would leave them green while prod silently reverted to 7 days. auth.ts
    // can't be imported here (it pulls the Node-only driver, KMS, and boot env),
    // so assert on its source.
    const authSrc = readFileSync(
      fileURLToPath(new URL("../src/lib/auth.ts", import.meta.url)),
      "utf8",
    );
    expect(authSrc).toContain(
      "accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS",
    );
    expect(authSrc).toContain(
      "refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS",
    );
  });

  it("would expire in 7 days on the plugin default (the bug being fixed)", async () => {
    // Control: same flow, no oidcConfig override. This is the behaviour that
    // reached prod and killed idle Cursor connections. If a Better Auth upgrade
    // moves the default, this fails and the comments above need rewriting —
    // which is the point.
    const { row, issuedAt } = await issueTokens({});

    const ttl = ttlSeconds(row.refreshTokenExpiresAt, issuedAt);
    expect(ttl).toBeGreaterThan(PLUGIN_DEFAULT_REFRESH_SECONDS - DAY_SECONDS);
    expect(ttl).toBeLessThan(PLUGIN_DEFAULT_REFRESH_SECONDS + DAY_SECONDS);
  });
});
