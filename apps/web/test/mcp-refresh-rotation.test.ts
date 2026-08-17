// Regression coverage for MCP OAuth refresh-token predecessor invalidation
// (lib/mcp-refresh-rotation.ts + the /mcp/token after-hook in lib/auth.ts).
//
// Background: Better Auth rotates but does not invalidate. Its refresh_token
// grant `create()`s a new oauthAccessToken row and leaves the presented one
// valid until its own expiry, so the same refresh token can be replayed for the
// whole idle window while the legitimate client keeps rotating on top of it.
// The "vulnerability reproduced" block below drives an UNPATCHED instance to
// prove that is really the upstream behaviour and not a misreading — it is the
// control that gives the patched assertions their meaning, and it will fail
// loudly if a Better Auth upgrade fixes this upstream (at which point our hook
// can go).
//
// At the plugin's 7-day default the exposure was already wrong; at the 90-day
// idle window this repo now sets (lib/mcp-token-lifetimes.ts) it would be
// indefensible, since each replay also mints a fresh 90-day token.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import {
  ROTATION_GRACE_SECONDS,
  expirePredecessorRefreshToken,
} from "../src/lib/mcp-refresh-rotation.ts";
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
} from "../src/lib/mcp-token-lifetimes.ts";

const VERIFIER = "midplane-rotation-verifier-0123456789abcdefghijklmn";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT_URI = "http://localhost:8787/callback";

interface TokenRow {
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
}

/** A Better Auth instance wired exactly like lib/auth.ts's token path, or
 *  without the hook when `patched` is false (the upstream-behaviour control). */
function buildAuth(patched: boolean) {
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
    hooks: patched
      ? {
          after: createAuthMiddleware(async (ctx) => {
            if (ctx.path !== "/mcp/token") return;
            const body = ctx.body as Record<string, unknown> | undefined;
            if (body?.grant_type !== "refresh_token") return;
            const returned = ctx.context.returned as
              | { access_token?: unknown }
              | undefined;
            if (!returned || typeof returned.access_token !== "string") return;
            await expirePredecessorRefreshToken(
              typeof body.refresh_token === "string"
                ? body.refresh_token
                : undefined,
              ctx.context.adapter,
            );
          }),
        }
      : undefined,
    plugins: [
      mcp({
        loginPage: "/sign-in",
        oidcConfig: {
          loginPage: "/sign-in",
          consentPage: "/oauth/consent",
          requirePKCE: true,
          scopes: ["mcp"],
          accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
          refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
        },
      }),
    ],
  });

  return { auth, db };
}

/** Full authorize → token flow; returns the first refresh token plus helpers. */
async function connect(patched: boolean) {
  const { auth, db } = buildAuth(patched);

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
    scope: "openid profile email offline_access",
    redirect_uri: REDIRECT_URI,
    state: "s",
  });
  const authorized = await auth.handler(
    new Request(`http://test.local/api/auth/mcp/authorize?${query}`, {
      headers: { cookie },
    }),
  );
  const code = new URL(authorized.headers.get("location")!).searchParams.get(
    "code",
  )!;

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
  const first = (await token.json()) as { refresh_token: string };

  const refreshAs = (refreshToken: string, asClientId: string) =>
    auth.handler(
      new Request("http://test.local/api/auth/mcp/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: asClientId,
        }),
      }),
    );
  const refresh = (refreshToken: string) => refreshAs(refreshToken, clientId);

  return {
    db,
    clientId,
    refresh,
    refreshAs,
    firstRefreshToken: first.refresh_token,
  };
}

describe("refresh-token replay (upstream Better Auth behaviour)", () => {
  it("lets a rotated refresh token be replayed when unpatched", async () => {
    const { refresh, firstRefreshToken } = await connect(false);

    // Legitimate rotation.
    expect((await refresh(firstRefreshToken)).status).toBe(200);
    // The superseded token still works — this is the hole being closed.
    expect((await refresh(firstRefreshToken)).status).toBe(200);
  });
});

describe("refresh-token predecessor invalidation", () => {
  it("keeps the legitimate rotation working", async () => {
    const { refresh, firstRefreshToken } = await connect(true);

    const rotated = await refresh(firstRefreshToken);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { refresh_token: string };
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(firstRefreshToken);

    // The successor rotates too — the chain doesn't dead-end after one hop.
    expect((await refresh(next.refresh_token)).status).toBe(200);
  });

  it("pulls the superseded token's expiry into the grace window", async () => {
    const { db, refresh, firstRefreshToken } = await connect(true);

    const before = db.oauthAccessToken.find(
      (r) => r.refreshToken === firstRefreshToken,
    )!;
    // Before rotation it carries the full 90-day idle window.
    expect(
      new Date(before.refreshTokenExpiresAt!).getTime() - Date.now(),
    ).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);

    const at = Date.now();
    expect((await refresh(firstRefreshToken)).status).toBe(200);

    const after = db.oauthAccessToken.find(
      (r) => r.refreshToken === firstRefreshToken,
    )!;
    const remainingMs =
      new Date(after.refreshTokenExpiresAt!).getTime() - at;
    // 90 days → ~60 seconds. Generous upper bound for flow latency; the point
    // is the order of magnitude, not the exact second.
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(
      (ROTATION_GRACE_SECONDS + 5) * 1000,
    );
  });

  it("rejects the superseded token once the grace window has passed", async () => {
    const { db, refresh, firstRefreshToken } = await connect(true);
    expect((await refresh(firstRefreshToken)).status).toBe(200);

    // Age the row past the grace rather than sleeping 60s. This is the same
    // comparison the plugin makes (`refreshTokenExpiresAt < new Date()`).
    const stale = db.oauthAccessToken.find(
      (r) => r.refreshToken === firstRefreshToken,
    )!;
    stale.refreshTokenExpiresAt = new Date(Date.now() - 1000);

    const replay = await refresh(firstRefreshToken);
    expect(replay.status).toBe(401);
    expect(JSON.stringify(await replay.json())).toContain("invalid_grant");
  });

  it("leaves the presented token alone when the exchange fails", async () => {
    // A rejected refresh must not burn the token. Otherwise anyone who merely
    // LEARNS a refresh token could expire a victim's live credential by POSTing
    // it with a bad client_id — turning the fix into a denial of service and
    // signing the user's agent out on demand.
    const { db, refresh, refreshAs, firstRefreshToken } = await connect(true);

    const expiryOf = () =>
      new Date(
        db.oauthAccessToken.find((r) => r.refreshToken === firstRefreshToken)!
          .refreshTokenExpiresAt!,
      ).getTime();
    const before = expiryOf();

    // Wrong client_id → the plugin rejects before rotating anything.
    const failed = await refreshAs(firstRefreshToken, "not-the-right-client");
    expect(failed.status).not.toBe(200);

    expect(expiryOf()).toBe(before);
    // And the token still works for its real owner.
    expect((await refresh(firstRefreshToken)).status).toBe(200);
  });
});

describe("lib/auth.ts wiring", () => {
  it("calls the invalidation from a /mcp/token after-hook", () => {
    // The blocks above build their own instance and attach the hook themselves,
    // so they'd stay green if the real one were dropped. auth.ts can't be
    // imported here (Node-only driver, KMS, boot env), so assert on its source.
    const authSrc = readFileSync(
      fileURLToPath(new URL("../src/lib/auth.ts", import.meta.url)),
      "utf8",
    );
    // The CALL SITE, not the identifier — matching the bare name would also be
    // satisfied by the leftover import after someone deletes the call.
    expect(authSrc).toContain("await expirePredecessorRefreshToken(");
    expect(authSrc).toContain('ctx.path !== "/mcp/token"');
    // The success gate. Without it a rejected exchange would expire the
    // presented token, which is the DoS covered above.
    expect(authSrc).toContain('typeof returned.access_token !== "string"');
  });
});

describe("expirePredecessorRefreshToken", () => {
  const adapterWith = (row: TokenRow | null) => {
    const updates: unknown[] = [];
    const reads: unknown[] = [];
    return {
      updates,
      reads,
      findOne: async <T,>(args: unknown): Promise<T | null> => {
        reads.push(args);
        return row as T | null;
      },
      update: async <T,>(args: unknown): Promise<T | null> => {
        updates.push(args);
        return null;
      },
    };
  };

  it("does not read anything without a refresh token", async () => {
    const adapter = adapterWith(null);
    await expect(
      expirePredecessorRefreshToken(undefined, adapter),
    ).resolves.toBe(false);
    expect(adapter.reads).toHaveLength(0);
  });

  it("no-ops on an unknown token", async () => {
    const adapter = adapterWith(null);
    await expect(expirePredecessorRefreshToken("ghost", adapter)).resolves.toBe(
      false,
    );
    expect(adapter.updates).toHaveLength(0);
  });

  it("never pushes an expiry further out", async () => {
    // A token already dying inside the grace window must be left alone —
    // otherwise a retry storm would keep renewing a superseded credential.
    const now = new Date("2026-08-17T12:00:00Z");
    const adapter = adapterWith({
      refreshTokenExpiresAt: new Date(now.getTime() + 5_000),
    });
    await expect(
      expirePredecessorRefreshToken("tok", adapter, now),
    ).resolves.toBe(false);
    expect(adapter.updates).toHaveLength(0);
  });

  it("pulls a long expiry in to exactly now + grace", async () => {
    const now = new Date("2026-08-17T12:00:00Z");
    const adapter = adapterWith({
      refreshTokenExpiresAt: new Date(now.getTime() + 90 * 24 * 3600 * 1000),
    });
    await expect(
      expirePredecessorRefreshToken("tok", adapter, now),
    ).resolves.toBe(true);
    expect(adapter.updates).toEqual([
      {
        model: "oauthAccessToken",
        where: [{ field: "refreshToken", value: "tok" }],
        update: {
          refreshTokenExpiresAt: new Date(
            now.getTime() + ROTATION_GRACE_SECONDS * 1000,
          ),
        },
      },
    ]);
  });
});
