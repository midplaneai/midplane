import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { generateSigningKey, mintToken, TokenVerifier } from "../src/auth.ts";

const AUDIENCE = "http://127.0.0.1:7433/mcp";

async function setup(revoked: string[] = []) {
  const { privateJwk, publicJwk } = await generateSigningKey();
  const verifier = new TokenVerifier({
    issuer: "local",
    audiences: () => [AUDIENCE],
    project: "p1",
    key: publicJwk,
    revoked: new Set(revoked),
  });
  const mint = (o: Partial<Parameters<typeof mintToken>[0]> = {}) =>
    mintToken({
      privateJwk,
      issuer: "local",
      audience: AUDIENCE,
      project: "p1",
      sub: "u1",
      clientId: "c1",
      grantId: "g1",
      databases: { main: "read", other: "write" },
      ttlSeconds: 60,
      ...o,
    });
  return { verifier, mint, privateJwk, publicJwk };
}

describe("token verification", () => {
  it("accepts a valid token and derives the caller from its claims", async () => {
    const { verifier, mint } = await setup();
    const v = await verifier.verify(await mint());
    expect(v.caller).toEqual({
      sub: "u1",
      client_id: "c1",
      grant_id: "g1",
      scopes: ["db:main:read", "db:other:write"],
    });
  });

  it("takes database access from `databases`, never from `scope`", async () => {
    const { verifier, privateJwk } = await setup();
    const sign = async (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt" })
        .setIssuer("local")
        .setAudience([AUDIENCE, "http://as.example/oauth2/userinfo"])
        .setSubject("u1")
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(await importJWK(privateJwk, "EdDSA"));
    const base = { client_id: "c1", grant_id: "g1", project: "p1" };
    await expect(
      verifier.verify(await sign({ ...base, scope: "db:main:write" })),
    ).rejects.toThrow(/databases/);
    await expect(
      verifier.verify(await sign({ ...base, databases: { main: "admin" } })),
    ).rejects.toThrow(/required claim/);
    const v = await verifier.verify(
      await sign({
        ...base,
        scope: "openid offline_access",
        databases: { main: "read" },
      }),
    );
    expect(v.caller.scopes).toEqual(["db:main:read"]);
    await expect(
      verifier.verify(
        await sign({ ...base, databases: { "Main DB": "read" } }),
      ),
    ).rejects.toThrow(/required claim/);
  });

  it("accepts only access tokens, not other JWTs signed with the same key", async () => {
    const { verifier, privateJwk } = await setup();
    const idToken = await new SignJWT({
      client_id: "c1",
      grant_id: "g1",
      project: "p1",
      databases: { main: "read" },
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer("local")
      .setAudience(AUDIENCE)
      .setSubject("u1")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(await importJWK(privateJwk, "EdDSA"));
    await expect(verifier.verify(idToken)).rejects.toThrow(/typ/);
  });

  it("accepts a token for any of this gateway's URLs, and names which", async () => {
    const { publicJwk, mint } = await setup();
    const tunnel = "https://db.abc123.tunnel.example.com/mcp";
    let audiences = [AUDIENCE, tunnel];
    const verifier = new TokenVerifier({
      issuer: "local",
      audiences: () => audiences,
      project: "p1",
      key: publicJwk,
    });
    expect((await verifier.verify(await mint())).resource).toBe(AUDIENCE);
    expect(
      (await verifier.verify(await mint({ audience: tunnel }))).resource,
    ).toBe(tunnel);
    await expect(
      verifier.verify(await mint({ audience: "https://other.example/mcp" })),
    ).rejects.toThrow(/"aud"/);
    // A URL that stops being this gateway's stops being accepted.
    audiences = [AUDIENCE];
    await expect(
      verifier.verify(await mint({ audience: tunnel })),
    ).rejects.toThrow(/"aud"/);
    audiences = [];
    await expect(verifier.verify(await mint())).rejects.toThrow(
      /no registered URL/,
    );
  });

  it("refuses a revoked personal access token", async () => {
    const { verifier, mint } = await setup(["jti-1"]);
    await expect(verifier.verify(await mint({ jti: "jti-1" }))).rejects.toThrow(
      /revoked/,
    );
    await expect(
      verifier.verify(await mint({ jti: "jti-2" })),
    ).resolves.toBeTruthy();
  });

  it("refuses an unsigned token", async () => {
    const { verifier } = await setup();
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const none = `${b64({ alg: "none" })}.${b64({ iss: "local", aud: AUDIENCE, exp: now + 60, sub: "u", client_id: "c", grant_id: "g", project: "p1", databases: {} })}.`;
    await expect(verifier.verify(none)).rejects.toThrow();
  });

  it("refuses a private key as the verification key", async () => {
    const { privateJwk } = await setup();
    const verifier = new TokenVerifier({
      issuer: "local",
      audiences: () => [AUDIENCE],
      project: "p1",
      key: privateJwk,
      revoked: new Set(),
    });
    await expect(verifier.verify("x.y.z")).rejects.toThrow();
  });

  it("allows only a little clock skew", async () => {
    const { verifier, mint } = await setup();
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifier.verify(await mint({ now: now - 62, ttlSeconds: 60 })),
    ).resolves.toBeTruthy();
    await expect(
      verifier.verify(await mint({ now: now - 70, ttlSeconds: 60 })),
    ).rejects.toThrow();
  });
});
