// Gateway configuration: one YAML file naming the listener, the audit file,
// the mask salt and each database. Secrets (DSNs, the salt, the enrollment
// token) are never inline: each names an environment variable or a file, so
// the config itself can be committed.
//
// Local mode (`midplane local`) also names a token key and each database's
// policy. Linked mode (`midplane gateway`) names the cloud instead: policies
// and token keys arrive in signed bundles.
//
// A gateway may answer on several public URLs: its direct URL and any
// tunnel or ingress URL in front of it (urls.ts).
//
// Off loopback a gateway serves TLS, with a certificate from files or one
// it gets itself from an ACME authority (acme.ts, certificates.ts).
//
// A linked gateway may be reached through Midplane's relay instead (relay.ts):
// at one Midplane URL, `https://gw-<slug>.<domain>`, with a certificate it
// gets through the relay, while it listens on loopback only, for health
// checks.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validatePolicy } from "@midplane/core";
import {
  DatabaseIdSchema,
  type DatabasePolicy,
  MAX_GATEWAY_URLS,
  RELAY_CONTROL_LABEL,
  relaySlugOf,
} from "@midplane/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ACME_HTTP_PORT, LETS_ENCRYPT } from "./acme.ts";

const SecretSourceSchema = z.union([
  z.strictObject({ env: z.string().min(1) }),
  z.strictObject({ file: z.string().min(1) }),
]);
type SecretSource = z.infer<typeof SecretSourceSchema>;

/** A URL agents reach the gateway at: http(s), nothing but a base path. */
const PublicUrlSchema = z.url().refine((u) => {
  const url = new URL(u);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "an http(s) URL without credentials, query or fragment");

const common = {
  listen: z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(7433),
      /**
       * More host names to accept in the Host header, for a proxy in front
       * of the gateway that rewrites it. Not token audiences.
       */
      allowed_hosts: z
        .array(z.string().regex(/^[A-Za-z0-9._-]+$|^\[[0-9A-Fa-f:.]+\]$/))
        .max(MAX_GATEWAY_URLS)
        .default([]),
    })
    .prefault({}),
  /**
   * The URLs agents reach this gateway at: direct, and through any tunnel
   * or ingress. A token's audience is `<one of them>/mcp`.
   */
  public_urls: z.array(PublicUrlSchema).min(1).max(MAX_GATEWAY_URLS).optional(),
  /** Shorthand for a single public URL. */
  public_url: PublicUrlSchema.optional(),
  /** Certificate files, or `acme` for one the gateway gets and renews itself. */
  tls: z
    .strictObject({
      cert_file: z.string().min(1).optional(),
      key_file: z.string().min(1).optional(),
      acme: z
        .strictObject({
          /**
           * Where the challenge listener binds (7480); port 80 forwards to
           * it. A relayed gateway binds none.
           */
          http_port: z.number().int().min(1).max(65535).optional(),
          directory_url: z.url().default(LETS_ENCRYPT),
        })
        .optional(),
    })
    .refine(
      (t) => !(t.acme && (t.cert_file || t.key_file)),
      "tls takes cert_file and key_file, or acme, not both",
    )
    .refine(
      (t) => t.acme || (t.cert_file && t.key_file),
      "tls needs cert_file and key_file, or acme",
    )
    .optional(),
  audit: z.strictObject({
    file: z.string().min(1),
    /**
     * Days to keep events the cloud has (local mode: all events); 0 keeps
     * everything. Only the oldest are ever deleted, so the rest verifies.
     */
    retention_days: z.number().int().min(0).max(3650).default(30),
  }),
  mask_salt: SecretSourceSchema.optional(),
  limits: z
    .strictObject({
      max_rows: z.number().int().min(1).max(1_000_000).default(1000),
      max_bytes: z
        .number()
        .int()
        .min(1024)
        .max(256 * 1024 * 1024)
        .default(1024 * 1024),
    })
    .prefault({}),
};

const atLeastOne = (d: Record<string, unknown>) => Object.keys(d).length > 0;

const LocalConfigSchema = z.strictObject({
  ...common,
  project: z.string().min(1).default("local"),
  auth: z.strictObject({
    issuer: z.string().min(1),
    /** A public JWK (or a JWKS) the tokens are verified with. */
    public_key_file: z.string().min(1),
    /** Personal access tokens revoked by `jti`. */
    revoked_token_ids: z.array(z.string().min(1)).default([]),
  }),
  databases: z
    .record(
      DatabaseIdSchema,
      z.strictObject({ dsn: SecretSourceSchema, policy: z.unknown() }),
    )
    .refine(atLeastOne, "at least one database"),
});

const LinkedConfigSchema = z.strictObject({
  ...common,
  /** Agents reach this gateway through Midplane's relay. */
  relay: z
    .strictObject({
      /** The relay's own name, `relay.<domain>`: where work connections go. */
      control: z.string().min(1),
    })
    .optional(),
  link: z.strictObject({
    /** Midplane Cloud's URL; its origin issues bundles and agent tokens. */
    cloud_url: z.url(),
    /**
     * The gateway's identity. A file is written at enrollment when missing;
     * an environment variable holds what `midplane enroll` printed.
     */
    identity: SecretSourceSchema,
    /** Needed only until the identity exists. */
    enrollment_token: SecretSourceSchema.optional(),
    /** The newest authentic bundle, enforced after a restart with the cloud down. */
    bundle_cache: z.string().min(1).default("bundle.jws"),
    /** How the dashboard names this gateway. */
    name: z.string().trim().min(1).max(80).optional(),
  }),
  databases: z
    .record(DatabaseIdSchema, z.strictObject({ dsn: SecretSourceSchema }))
    .refine(atLeastOne, "at least one database"),
});

export interface DatabaseConfig {
  id: string;
  dsn: string;
}

export interface LocalDatabaseConfig extends DatabaseConfig {
  policy: DatabasePolicy;
}

/** Where a TLS listener's certificate comes from. */
export type TlsConfig =
  | {
      kind: "files";
      certFile: string;
      keyFile: string;
      /** As read at start. */
      cert: string;
      key: string;
    }
  | {
      kind: "acme";
      /** The host names to certify: the https public URL's host. */
      names: string[];
      /** The challenge listener's port; null when challenges come through the relay. */
      httpPort: number | null;
      directoryUrl: string;
      /** Where the account key, the certificate and its key are kept. */
      dir: string;
    };

/** What both modes share. */
export interface BaseConfig {
  listen: { host: string; port: number };
  /** Base URLs agents reach the gateway at, without a trailing slash; may be none. */
  publicUrls: string[];
  /** More host names the Host header may name, for a proxy that rewrites it. */
  allowedHosts: string[];
  tls: TlsConfig | null;
  auditFile: string;
  /** Days events are kept once owed to no one; 0 keeps everything. */
  auditRetentionDays: number;
  maskSalt: string | null;
  limits: { maxRows: number; maxBytes: number };
}

export interface LocalConfig extends BaseConfig {
  project: string;
  auth: { issuer: string; publicKey: unknown; revoked: Set<string> };
  databases: Map<string, LocalDatabaseConfig>;
}

export type IdentitySource =
  | { kind: "file"; path: string }
  | { kind: "env"; name: string; value: string | null };

/** Where a relayed gateway opens its work connections. */
export interface RelayConfig {
  /** The relay's own name, `relay.<domain>`. */
  control: string;
  /** Gateway host names are `<slug>.<domain>`. */
  domain: string;
}

export interface LinkedConfig extends BaseConfig {
  /** Set when agents reach this gateway through the relay. */
  relay: RelayConfig | null;
  link: {
    /** The cloud's origin. */
    cloudUrl: string;
    identity: IdentitySource;
    /** Reads the enrollment token; throws a ConfigError when there is none. */
    enrollmentToken: () => string;
    bundleCache: string;
    name: string | null;
  };
  databases: Map<string, DatabaseConfig>;
}

/** The salt keys consistent-hash; too short and its tokens are guessable. */
const MIN_SALT_LENGTH = 32;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readSecret(
  source: SecretSource,
  base: string,
  env: NodeJS.ProcessEnv,
  what: string,
): string {
  if ("env" in source) {
    const value = env[source.env];
    if (!value)
      throw new ConfigError(
        `${what}: environment variable ${source.env} is not set`,
      );
    return value;
  }
  const path = isAbsolute(source.file)
    ? source.file
    : resolve(base, source.file);
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError(`${what}: cannot read ${path}`);
  }
}

export function isLoopback(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "localhost"
  );
}

function isUnspecified(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function parseDocument<T extends z.ZodType>(schema: T, document: unknown) {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(config)"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data as z.output<T>;
}

type CommonDocument = {
  listen: { host: string; port: number; allowed_hosts: string[] };
  public_urls?: string[] | undefined;
  public_url?: string | undefined;
  tls?:
    | {
        cert_file?: string | undefined;
        key_file?: string | undefined;
        acme?:
          | { http_port?: number | undefined; directory_url: string }
          | undefined;
      }
    | undefined;
  audit: { file: string; retention_days: number };
  mask_salt?: SecretSource | undefined;
  limits: { max_rows: number; max_bytes: number };
};

function readTlsFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(
      `${what}: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
}

function tlsConfig(
  tls: NonNullable<CommonDocument["tls"]>,
  publicUrls: readonly string[],
  listenPort: number,
  file: (p: string) => string,
  base: string,
  relayed: boolean,
): TlsConfig {
  if (!tls.acme) {
    const certFile = file(tls.cert_file as string);
    const keyFile = file(tls.key_file as string);
    return {
      kind: "files",
      certFile,
      keyFile,
      cert: readTlsFile(certFile, "tls.cert_file"),
      key: readTlsFile(keyFile, "tls.key_file"),
    };
  }
  // Each name must lead the authority here, on port 80: one host, the
  // gateway's own, not a tunnel's or an ingress's.
  const hosts = [
    ...new Set(
      publicUrls
        .map((u) => new URL(u))
        .filter((u) => u.protocol === "https:")
        .map((u) => u.hostname),
    ),
  ];
  if (hosts.length !== 1) {
    throw new ConfigError(
      `tls.acme needs public_urls to name one https host to certify${hosts.length > 1 ? `, not ${hosts.length}` : ""}`,
    );
  }
  if (hosts.some((h) => isIP(h.replace(/^\[(.*)\]$/, "$1")))) {
    throw new ConfigError(
      "tls.acme: an automatic certificate needs a host name, not an IP address",
    );
  }
  const directory = new URL(tls.acme.directory_url);
  if (directory.protocol !== "https:" && !isLoopback(directory.hostname)) {
    throw new ConfigError(
      "tls.acme.directory_url must use https (http only on this machine)",
    );
  }
  // Through the relay, challenges arrive on work connections: no port.
  const httpPort = relayed ? null : (tls.acme.http_port ?? ACME_HTTP_PORT);
  if (httpPort === listenPort) {
    throw new ConfigError("tls.acme.http_port must differ from listen.port");
  }
  return {
    kind: "acme",
    names: hosts,
    httpPort,
    directoryUrl: directory.href,
    dir: join(base, "acme"),
  };
}

function baseConfig(
  c: CommonDocument,
  base: string,
  env: NodeJS.ProcessEnv,
  relayed = false,
): BaseConfig {
  const file = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  // Every request is authenticated, so any interface is allowed, but off
  // loopback the token must not cross the network in the clear.
  if (!isLoopback(c.listen.host) && !c.tls) {
    throw new ConfigError(
      `listen.host ${c.listen.host} is not loopback, so tls is required`,
    );
  }
  if (c.public_url && c.public_urls) {
    throw new ConfigError("set public_urls or public_url, not both");
  }
  const publicUrls = (
    c.public_urls ?? (c.public_url ? [c.public_url] : [])
  ).map((u) => {
    // As the cloud writes it: lowercase host, no default port.
    const url = new URL(u);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  });
  if (new Set(publicUrls).size !== publicUrls.length) {
    throw new ConfigError("public_urls lists a URL twice");
  }
  // Agents reach the gateway by name, and tokens name that URL: an address
  // like 0.0.0.0 is neither.
  if (publicUrls.length === 0 && isUnspecified(c.listen.host)) {
    throw new ConfigError(
      `listen.host ${c.listen.host} listens on every interface, so public_urls must name the URLs agents use`,
    );
  }
  let maskSalt: string | null = null;
  if (c.mask_salt) maskSalt = readSecret(c.mask_salt, base, env, "mask_salt");
  if (maskSalt !== null && maskSalt.length < MIN_SALT_LENGTH) {
    throw new ConfigError(
      `mask_salt must be at least ${MIN_SALT_LENGTH} characters`,
    );
  }
  return {
    listen: { host: c.listen.host, port: c.listen.port },
    publicUrls,
    allowedHosts: c.listen.allowed_hosts,
    tls: c.tls
      ? tlsConfig(c.tls, publicUrls, c.listen.port, file, base, relayed)
      : null,
    auditFile: file(c.audit.file),
    auditRetentionDays: c.audit.retention_days,
    maskSalt,
    limits: { maxRows: c.limits.max_rows, maxBytes: c.limits.max_bytes },
  };
}

/** A host name of two labels or more, lowercase, as a relay domain is. */
const HOST_NAME =
  /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A relayed gateway's rules, each refusal naming its key: the control name
 * is `relay.<domain>`; the one public URL is the gateway's relay URL,
 * `https://gw-<slug>.<domain>`; the certificate comes from ACME through the
 * relay, which binds no port; and the listener is on loopback, for health
 * checks, since agents come through the relay.
 */
function relayConfig(
  c: CommonDocument & { relay: { control: string } },
): RelayConfig {
  const control = c.relay.control.trim().toLowerCase();
  const prefix = `${RELAY_CONTROL_LABEL}.`;
  const domain = control.slice(prefix.length);
  if (!control.startsWith(prefix) || !HOST_NAME.test(domain)) {
    throw new ConfigError(
      `relay.control must be the relay's name, ${prefix}<domain> such as relay.eu.midplane.app, not ${JSON.stringify(c.relay.control)}`,
    );
  }
  const relayUrl = `https://gw-<8 characters>.${domain}`;
  const urls = [
    ...(c.public_urls ?? []),
    ...(c.public_url ? [c.public_url] : []),
  ];
  const key = c.public_urls ? "public_urls" : "public_url";
  if (urls.length !== 1) {
    throw new ConfigError(
      `${key}: a gateway reached through the relay has one public URL, its relay URL ${relayUrl}`,
    );
  }
  const url = new URL(urls[0] as string);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.pathname.replace(/\/+$/, "") !== "" ||
    !relaySlugOf(url.hostname, domain)
  ) {
    throw new ConfigError(
      `${key} must be this gateway's relay URL, ${relayUrl}, not ${urls[0]}`,
    );
  }
  if (!c.tls?.acme || c.tls.cert_file || c.tls.key_file) {
    throw new ConfigError(
      "tls: a gateway reached through the relay gets its certificate through it: set tls: { acme: {} }",
    );
  }
  if (c.tls.acme.http_port !== undefined) {
    throw new ConfigError(
      "tls.acme.http_port: a gateway reached through the relay answers its challenges there, so it binds no port",
    );
  }
  if (!isLoopback(c.listen.host)) {
    throw new ConfigError(
      `listen.host ${c.listen.host}: a gateway reached through the relay listens on loopback only (127.0.0.1), for health checks`,
    );
  }
  return { control, domain };
}

/** Parse and validate a local-mode config; `path` anchors relative file paths. */
export function parseConfig(
  text: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalConfig {
  const base = dirname(path);
  const document: unknown = parseYaml(text);
  if (
    typeof document === "object" &&
    document !== null &&
    "relay" in document
  ) {
    throw new ConfigError(
      "relay: only a linked gateway (midplane gateway) is reached through the relay",
    );
  }
  const c = parseDocument(LocalConfigSchema, document);
  const common = baseConfig(c, base, env);

  const databases = new Map<string, LocalDatabaseConfig>();
  for (const [id, db] of Object.entries(c.databases)) {
    const policy = validatePolicy(db.policy ?? {});
    if (!policy.ok) {
      throw new ConfigError(
        `databases.${id}.policy: ${policy.errors.join("; ")}`,
      );
    }
    databases.set(id, {
      id,
      dsn: readSecret(db.dsn, base, env, `databases.${id}.dsn`),
      policy: policy.policy,
    });
  }

  const needsSalt = [...databases.values()].some(
    (d) => Object.keys(d.policy.masks).length > 0,
  );
  if (needsSalt && !common.maskSalt) {
    throw new ConfigError("a database has masks, so mask_salt is required");
  }

  let publicKey: unknown;
  const keyFile = isAbsolute(c.auth.public_key_file)
    ? c.auth.public_key_file
    : resolve(base, c.auth.public_key_file);
  try {
    publicKey = JSON.parse(readFileSync(keyFile, "utf8"));
  } catch {
    throw new ConfigError(
      `auth.public_key_file: cannot read a JSON key from ${c.auth.public_key_file}`,
    );
  }

  return {
    ...common,
    project: c.project,
    auth: {
      issuer: c.auth.issuer,
      publicKey,
      revoked: new Set(c.auth.revoked_token_ids),
    },
    databases,
  };
}

/** Parse and validate a linked-mode config; `path` anchors relative file paths. */
export function parseLinkedConfig(
  text: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LinkedConfig {
  const base = dirname(path);
  const c = parseDocument(LinkedConfigSchema, parseYaml(text));
  const relay = c.relay ? relayConfig({ ...c, relay: c.relay }) : null;
  const common = baseConfig(c, base, env, relay !== null);

  const cloud = new URL(c.link.cloud_url);
  if (cloud.protocol !== "https:" && !isLoopback(cloud.hostname)) {
    throw new ConfigError(
      "link.cloud_url must use https (http only on this machine)",
    );
  }

  const databases = new Map<string, DatabaseConfig>();
  for (const [id, db] of Object.entries(c.databases)) {
    databases.set(id, {
      id,
      dsn: readSecret(db.dsn, base, env, `databases.${id}.dsn`),
    });
  }

  const identity: IdentitySource =
    "file" in c.link.identity
      ? {
          kind: "file",
          path: isAbsolute(c.link.identity.file)
            ? c.link.identity.file
            : resolve(base, c.link.identity.file),
        }
      : {
          kind: "env",
          name: c.link.identity.env,
          value: env[c.link.identity.env] || null,
        };
  const tokenSource = c.link.enrollment_token;

  return {
    ...common,
    relay,
    link: {
      cloudUrl: cloud.origin,
      identity,
      enrollmentToken: () => {
        if (!tokenSource) {
          throw new ConfigError(
            "this gateway isn't enrolled yet: set link.enrollment_token to a token from the project page",
          );
        }
        return readSecret(tokenSource, base, env, "link.enrollment_token");
      },
      bundleCache: isAbsolute(c.link.bundle_cache)
        ? c.link.bundle_cache
        : resolve(base, c.link.bundle_cache),
      name: c.link.name ?? null,
    },
    databases,
  };
}

/** The listener's own URL, from its configured host and port. */
export function listenerUrlOf(config: BaseConfig): string {
  const host =
    config.listen.host.includes(":") && !config.listen.host.startsWith("[")
      ? `[${config.listen.host}]`
      : config.listen.host;
  return `${config.tls ? "https" : "http"}://${host}:${config.listen.port}`;
}

/**
 * The base URLs agents reach the gateway at: `public_urls`, else the
 * listener. Tokens name `<one of them>/mcp` as their audience, over HTTP
 * and stdio alike.
 */
export function baseUrlsOf(config: BaseConfig, listener?: string): string[] {
  return config.publicUrls.length > 0
    ? [...config.publicUrls]
    : [listener ?? listenerUrlOf(config)];
}

/** The first base URL: the one `midplane token` mints for and logs name. */
export function baseUrlOf(config: BaseConfig): string {
  return baseUrlsOf(config)[0] as string;
}

function readConfigFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read config ${path}`);
  }
}

export function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalConfig {
  return parseConfig(readConfigFile(path), resolve(path), env);
}

export function loadLinkedConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LinkedConfig {
  return parseLinkedConfig(readConfigFile(path), resolve(path), env);
}

/**
 * The audit file a config names, read without the rest of the config: the
 * audit commands need no DSN or secret in the environment.
 */
export function auditFileOf(path: string): string {
  const doc = parseYaml(readConfigFile(path)) as {
    audit?: { file?: unknown };
  } | null;
  const file = doc?.audit?.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new ConfigError(`${path} names no audit.file`);
  }
  return isAbsolute(file) ? file : resolve(dirname(resolve(path)), file);
}
