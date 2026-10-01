// The link: the gateway-to-cloud channel, always opened by the gateway.
// Messages a gateway sends are strict, so a field the protocol doesn't name
// (a row value, a DSN) is refused rather than stored. Messages the cloud
// sends are read leniently, so a newer cloud can add fields an older gateway
// ignores; bundles say which of theirs are critical.

import { z } from "zod";
import { CountPreviewResultSchema } from "./approvals.ts";
import { AuditHeadSchema } from "./audit.ts";
import { DatabaseIdSchema } from "./claims.ts";

/** Every link call is under this path of the cloud's origin. */
export const LINK_API_PREFIX = "/link/v1";

/** The OAuth scope a gateway's link access tokens carry. */
export const LINK_SCOPE = "link";

/** The resource (token audience) of the link API at a cloud origin. */
export function linkResource(cloudOrigin: string): string {
  return `${cloudOrigin}${LINK_API_PREFIX}`;
}

/** The long poll's longest wait before the cloud answers with nothing. */
export const SYNC_WAIT_MS = 50_000;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The most URLs one gateway answers on: its direct URL plus tunnel and
 * ingress URLs. Each is `<base URL>/mcp`, a token audience it accepts.
 */
export const MAX_GATEWAY_URLS = 8;

const GatewayResourcesSchema = z.array(z.url()).max(MAX_GATEWAY_URLS);

/**
 * `mpe1_` then base64url (no padding) of a 32-byte pin and a 32-byte secret.
 * The pin is the SHA-256 JWK thumbprint (RFC 7638) of the cloud's
 * bundle-signing key.
 */
export const EnrollmentTokenSchema = z
  .string()
  .regex(/^mpe1_[A-Za-z0-9_-]{86}$/, "not a Midplane enrollment token");

export const ENROLLMENT_TOKEN_PREFIX = "mpe1_";

/** An Ed25519 public key as a JWK. Private members are refused. */
export const Ed25519PublicJwkSchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  alg: z.literal("EdDSA").optional(),
  use: z.literal("sig").optional(),
  kid: z.string().min(1).max(128).optional(),
});
export type Ed25519PublicJwk = z.infer<typeof Ed25519PublicJwkSchema>;

// ── enrollment ──────────────────────────────────────────────────────────────

export const EnrollRequestSchema = z.strictObject({
  token: EnrollmentTokenSchema,
  /** The key the gateway signs its client assertions with. */
  public_key: Ed25519PublicJwkSchema,
  /**
   * `<public base URL>/mcp` for each URL its config names: the resources,
   * and token audiences, it registers. The first is its identity's.
   */
  resources: GatewayResourcesSchema.min(1),
  name: z.string().trim().min(1).max(80).optional(),
  version: z.string().min(1).max(64),
  features: z.array(z.string().min(1).max(64)).max(64),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  /** The cloud's bundle-signing public key; its thumbprint must equal the token's pin. */
  signing_key: Ed25519PublicJwkSchema.loose(),
  /** A compact JWS (`typ: mp-identity`) over IdentityPayload, signed with that key. */
  identity: z.string().min(1),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

export const IDENTITY_JWS_TYPE = "mp-identity";

/** Who a gateway is, as the cloud signed it at enrollment. */
export const IdentityPayloadSchema = z.object({
  v: z.literal(1),
  /** The cloud's origin: the issuer of bundles and of agent tokens. */
  iss: z.string().min(1),
  project_id: z.string().min(1),
  gateway_id: z.string().min(1),
  /** The gateway's OAuth client, authenticated with private_key_jwt. */
  client_id: z.string().min(1),
  /** The first resource it enrolled with. Bundles list all of its URLs. */
  resource: z.string().min(1),
  /** RFC 7638 thumbprint of the key the gateway enrolled with. */
  key_thumbprint: z.string().min(1),
  /** The project's bundle version at enrollment; anything older is refused. */
  bundle_version: z.number().int().nonnegative(),
  iat: z.number().int(),
});
export type IdentityPayload = z.infer<typeof IdentityPayloadSchema>;

// ── bundles ─────────────────────────────────────────────────────────────────

export const BUNDLE_JWS_TYPE = "mp-bundle";

/** The bundle format this protocol describes. */
export const BUNDLE_FORMAT = 1;

/** The payload fields this protocol defines; any may be named in `crit`. */
export const BUNDLE_FIELDS: ReadonlySet<string> = new Set([
  "v",
  "iss",
  "project_id",
  "version",
  "iat",
  "paused",
  "crit",
  "jwks",
  "revoked_tokens",
  "databases",
  "gateways",
  "audit",
]);

/**
 * A signed, versioned, complete policy for one project: always a full
 * replacement. Unknown fields are ignored unless listed in `crit`. Each
 * database's policy is carried as authored and validated by the core that
 * enforces it.
 */
export const BundlePayloadSchema = z.looseObject({
  v: z.number().int().positive(),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  version: z.number().int().positive(),
  iat: z.number().int(),
  /** A paused project's gateways enforce nothing: every call is refused. */
  paused: z.boolean(),
  /** Payload fields a gateway must understand to enforce this bundle. */
  crit: z.array(z.string().min(1)).default([]),
  /** Verification keys for agent access tokens and personal access tokens. */
  jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  /** `jti`s of revoked personal access tokens that haven't expired yet. */
  revoked_tokens: z.array(z.string().min(1)).default([]),
  databases: z.record(DatabaseIdSchema, z.unknown()),
  /**
   * Each live gateway of the project by id, with the resources registered
   * for it: the token audiences it accepts and the hosts it answers to.
   * Absent from bundles made before gateways had several URLs; a gateway
   * then accepts the resource it enrolled with.
   */
  gateways: z
    .record(
      z.string().min(1),
      z.looseObject({ resources: z.array(z.string().min(1)) }),
    )
    .optional(),
  /**
   * What the audit push sends. `full_text`: the databases whose statements
   * go up as written, with the agent's intent and a denial's reason; every
   * other database's go up redacted. Never critical, and read leniently: a
   * gateway that can't read it sends redacted statements only.
   */
  audit: z
    .looseObject({ full_text: z.array(DatabaseIdSchema).default([]) })
    .optional()
    .catch(undefined),
});
export type BundlePayload = z.infer<typeof BundlePayloadSchema>;

// ── freshness ───────────────────────────────────────────────────────────────

export const FRESHNESS_JWS_TYPE = "mp-freshness";

/**
 * The cloud's answer to one sync's nonce: the project's latest bundle
 * version, signed with the bundle key. A gateway takes a bundle from a sync
 * only if it is that version, so nothing between it and the cloud can hand
 * it an older authentic bundle, not even after it has lost its cache.
 */
export const FreshnessPayloadSchema = z.object({
  v: z.literal(1),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  /** 0 when the project has no bundle yet. */
  version: z.number().int().nonnegative(),
  nonce: z.string().min(1),
  iat: z.number().int(),
});
export type FreshnessPayload = z.infer<typeof FreshnessPayloadSchema>;

// ── catalogs ────────────────────────────────────────────────────────────────

/**
 * Each database's catalog snapshot goes up on its own call, capped far above
 * the other link calls: `POST <prefix>/catalogs/<database id>`, the body a
 * CatalogSnapshot with every view definition redacted by the core.
 */
export const CATALOG_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export function catalogUploadPath(databaseId: string): string {
  return `/catalogs/${databaseId}`;
}

/**
 * SHA-256 (hex) of each database's upload body, byte for byte, keyed by
 * database id. The status carries the gateway's; the sync answer carries the
 * cloud's, and the gateway uploads where they differ.
 */
export const CatalogHashesSchema = z
  .record(DatabaseIdSchema, Sha256HexSchema)
  .refine((r) => Object.keys(r).length <= 256, "too many databases");
export type CatalogHashes = z.infer<typeof CatalogHashesSchema>;

// ── sync ────────────────────────────────────────────────────────────────────

export const GatewayStateSchema = z.enum([
  /** Enforcing a bundle. */
  "enforcing",
  /** The project is paused; nothing runs. */
  "paused",
  /** The newest authentic bundle can't be enforced; nothing runs. */
  "halted",
  /** No bundle yet; nothing runs. */
  "waiting",
]);
export type GatewayState = z.infer<typeof GatewayStateSchema>;

/** The body of every sync: the gateway's status, which replaces a heartbeat. */
export const GatewayStatusSchema = z.strictObject({
  /** The newest authentic bundle it holds, enforced or not. */
  bundle_version: z.number().int().positive().nullable(),
  state: GatewayStateSchema,
  /** Why it is halted or waiting. */
  reason: z.string().max(500).nullable(),
  /**
   * The last bundle it refused as inauthentic, foreign or stale, and why.
   * The cloud doesn't send the same bytes (by SHA-256) again.
   */
  rejected: z
    .strictObject({
      version: z.number().int().nullable(),
      reason: z.string().max(500),
      sha256: Sha256HexSchema,
    })
    .nullable(),
  version: z.string().min(1).max(64),
  features: z.array(z.string().min(1).max(64)).max(64),
  /** Database ids the gateway has a DSN for. */
  databases: z.array(DatabaseIdSchema).max(256),
  /**
   * `<base URL>/mcp` for each URL its config names. The cloud registers the
   * ones no other gateway holds; bundles say which are registered.
   */
  resources: GatewayResourcesSchema.optional(),
  /** Fresh for every sync; the answer's freshness proof must name it. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,86}$/),
  /** The hash of each database's catalog upload as it stands now. */
  catalogs: CatalogHashesSchema.optional(),
  /** The head of its audit file, and how much the cloud doesn't have yet. */
  audit: AuditHeadSchema.optional(),
});
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

export const CommandKindSchema = z.enum([
  "test_connection",
  "refresh_catalog",
  "count_preview",
]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

/** A request from the cloud. Kinds a gateway doesn't know are answered as such. */
export const CommandSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1),
  payload: z.unknown(),
});
export type Command = z.infer<typeof CommandSchema>;

export const SyncResponseSchema = z.object({
  /** A compact JWS (`typ: mp-bundle`), when the gateway's is older. */
  bundle: z.string().min(1).optional(),
  /** A compact JWS (`typ: mp-freshness`) over this sync's nonce. */
  freshness: z.string().min(1).optional(),
  commands: z.array(CommandSchema).default([]),
  /** The hash of the catalog the cloud holds for each database it knows. */
  catalogs: CatalogHashesSchema.default({}),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;
/** A sync answer as the cloud writes it, before defaults. */
export type SyncResponseInput = z.input<typeof SyncResponseSchema>;

// ── command results: metadata only, never a row value ──────────────────────

export const TestConnectionResultSchema = z.strictObject({
  databases: z.record(
    DatabaseIdSchema,
    z.strictObject({
      ok: z.boolean(),
      latency_ms: z.number().nonnegative(),
      /** SQLSTATE or Node error code of a failed connection. */
      code: z.string().max(32).nullable(),
    }),
  ),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

/** What a catalog refresh found and sent, per database: metadata only. */
export const RefreshCatalogResultSchema = z.strictObject({
  databases: z.record(
    DatabaseIdSchema,
    z.strictObject({
      /** Read and taken by the cloud. */
      ok: z.boolean(),
      /** The upload's hash, when the catalog could be read. */
      sha256: Sha256HexSchema.nullable(),
      /** SQLSTATE or Node error code of a failed read, or why the upload failed. */
      code: z.string().max(32).nullable(),
    }),
  ),
});
export type RefreshCatalogResult = z.infer<typeof RefreshCatalogResultSchema>;

export const CommandResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(["unsupported", "failed"]),
  }),
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

/** Each command kind's result schema. */
export const COMMAND_RESULTS = {
  test_connection: TestConnectionResultSchema,
  refresh_catalog: RefreshCatalogResultSchema,
  count_preview: CountPreviewResultSchema,
} as const satisfies Record<CommandKind, z.ZodType>;
