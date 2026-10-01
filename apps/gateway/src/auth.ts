// Agent authentication. Every MCP request carries a JWT access token that is
// verified here, locally, against keys the gateway already holds (in linked
// mode, from the bundle; in local mode, from a key file). Identity comes only
// from a verified token, never from a request header.

import {
  type AccessTokenClaims,
  AccessTokenClaimsSchema,
  type CallerClaims,
  callerFromClaims,
  type DatabaseGrants,
} from "@midplane/protocol";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JSONWebKeySet,
  type JWK,
  jwtVerify,
  SignJWT,
} from "jose";

/** Asymmetric signatures only; `none` and HMAC are never accepted. */
const ALGORITHMS = ["EdDSA", "Ed25519", "ES256"];
const CLOCK_TOLERANCE_S = 5;

export interface VerifierOptions {
  issuer: string;
  /**
   * This gateway's resource URLs: a token must name one of them, and a
   * token for anything else is refused.
   */
  audiences: () => readonly string[];
  project: string;
  /** A public JWK or a JWKS; in linked mode, none until a bundle brings keys. */
  key?: unknown;
  revoked?: ReadonlySet<string>;
}

/** A verified caller: the token's claims and what the core needs of them. */
export interface VerifiedCaller {
  claims: AccessTokenClaims;
  caller: CallerClaims;
  /** The URL of this gateway the token names. */
  resource: string;
}

function invalid(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

type KeyInput = Parameters<typeof jwtVerify>[1];

/** JWK members only a private key has. */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];

function isPrivate(jwk: object): boolean {
  return PRIVATE_MEMBERS.some((m) => m in jwk);
}

async function keyFrom(key: unknown): Promise<KeyInput> {
  if (
    key &&
    typeof key === "object" &&
    Array.isArray((key as JSONWebKeySet).keys)
  ) {
    const set = key as JSONWebKeySet;
    if (set.keys.some((k) => !k || typeof k !== "object" || isPrivate(k)))
      throw new Error("the verification key set holds a private key");
    return createLocalJWKSet(set) as KeyInput;
  }
  const jwk = key as JWK;
  if (!jwk || typeof jwk !== "object" || isPrivate(jwk))
    throw new Error("the verification key file holds a private key");
  return (await importJWK(jwk, jwk.alg ?? "EdDSA")) as KeyInput;
}

export class TokenVerifier {
  private readonly options: VerifierOptions;
  private key: Promise<KeyInput> | null;
  private revoked: ReadonlySet<string>;

  constructor(options: VerifierOptions) {
    this.options = options;
    this.key = options.key === undefined ? null : keyFrom(options.key);
    this.key?.catch(() => {});
    this.revoked = options.revoked ?? new Set();
  }

  /**
   * Replace the keys and revocations, as a newly enforced bundle does. The
   * new keys are imported (and checked public) before anything changes.
   */
  async setKeys(key: unknown, revoked: ReadonlySet<string>): Promise<void> {
    const imported = await keyFrom(key);
    this.key = Promise.resolve(imported);
    this.revoked = revoked;
  }

  /** Whether any token can be verified yet. */
  get hasKeys(): boolean {
    return this.key !== null;
  }

  /** Verify a token and return its caller, or throw an `invalid_token` OAuthError. */
  async verify(token: string): Promise<VerifiedCaller> {
    let payload: unknown;
    const audiences = this.options.audiences();
    try {
      if (!this.key)
        throw new Error("this gateway has no verification keys yet");
      if (audiences.length === 0)
        throw new Error("this gateway has no registered URL");
      const result = await jwtVerify(token, await this.key, {
        issuer: this.options.issuer,
        audience: [...audiences],
        // RFC 9068: only access tokens. The server's ID and logout tokens
        // are signed with the same key.
        typ: "at+jwt",
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: [
          "exp",
          "sub",
          "client_id",
          "grant_id",
          "project",
          "databases",
        ],
      });
      payload = result.payload;
    } catch (err) {
      throw invalid(`token rejected: ${(err as Error).message}`);
    }
    const claims = AccessTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw invalid("token is missing a required claim");
    if (claims.data.project !== this.options.project) {
      throw invalid("token is for another project");
    }
    if (claims.data.jti && this.revoked.has(claims.data.jti)) {
      throw invalid("token has been revoked");
    }
    const resource = [claims.data.aud]
      .flat()
      .find((a) => audiences.includes(a));
    if (!resource) throw invalid("token is for another resource");
    return {
      claims: claims.data,
      caller: callerFromClaims(claims.data),
      resource,
    };
  }

  /** The MCP SDK's verifier shape, carrying the verified caller in `extra`. */
  asOAuthVerifier(): { verifyAccessToken(token: string): Promise<AuthInfo> } {
    return {
      verifyAccessToken: async (token) => {
        const verified = await this.verify(token);
        return {
          token,
          clientId: verified.claims.client_id,
          scopes: verified.caller.scopes,
          expiresAt: verified.claims.exp,
          resource: new URL(verified.resource),
          extra: { verified },
        };
      },
    };
  }
}

/** The verified caller a request's AuthInfo carries, if any. */
export function verifiedCallerOf(
  auth: AuthInfo | undefined,
): VerifiedCaller | null {
  const v = auth?.extra?.verified as VerifiedCaller | undefined;
  return v ?? null;
}

// ── local keys and tokens (`midplane keygen`, `midplane token`) ─────────────

export async function generateSigningKey(): Promise<{
  privateJwk: JWK;
  publicJwk: JWK;
}> {
  const { privateKey, publicKey } = await generateKeyPair("Ed25519", {
    extractable: true,
  });
  const privateJwk = {
    ...(await exportJWK(privateKey)),
    alg: "EdDSA",
    use: "sig",
  };
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: "EdDSA",
    use: "sig",
  };
  return { privateJwk, publicJwk };
}

export interface MintOptions {
  privateJwk: JWK;
  issuer: string;
  audience: string;
  project: string;
  sub: string;
  clientId: string;
  grantId: string;
  databases: DatabaseGrants;
  ttlSeconds: number;
  jti?: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
}

export async function mintToken(o: MintOptions): Promise<string> {
  const key = await importJWK(o.privateJwk, o.privateJwk.alg ?? "EdDSA");
  const now = o.now ?? Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({
    client_id: o.clientId,
    grant_id: o.grantId,
    project: o.project,
    databases: o.databases,
  })
    .setProtectedHeader({ alg: o.privateJwk.alg ?? "EdDSA", typ: "at+jwt" })
    .setIssuer(o.issuer)
    .setAudience(o.audience)
    .setSubject(o.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + o.ttlSeconds);
  if (o.jti) jwt = jwt.setJti(o.jti);
  return jwt.sign(key);
}
