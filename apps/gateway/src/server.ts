// Starting a gateway: open the audit log (refusing to start if it can't be
// written), read each database's catalog, then serve MCP over HTTP or stdio.
//
// Local mode enforces the policies in its config with a local token key, and
// won't start without every catalog. Linked mode enrolls with Midplane Cloud
// if it has no identity yet, enforces its cached bundle if it has one, and
// long-polls the cloud for newer ones; a database it can't read yet isn't
// served, and is tried again until it can be.

import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { DatabasePolicy } from "@midplane/protocol";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Hono } from "hono";
import { localTaintStore } from "./approvals.ts";
import { LocalAuditLog } from "./audit.ts";
import type { AuditPusherOptions } from "./audit-push.ts";
import { TokenVerifier } from "./auth.ts";
import {
  type BaseConfig,
  baseUrlsOf,
  ConfigError,
  type DatabaseConfig,
  isLoopback,
  type LinkedConfig,
  type LocalConfig,
} from "./config.ts";
import { DatabaseExecutor } from "./executor.ts";
import { type DatabaseRuntime, type Enforcement, Gateway } from "./gateway.ts";
import { HealthBook } from "./health.ts";
import { buildApp } from "./http.ts";
import {
  enroll,
  type GatewayIdentity,
  readIdentity,
  writeIdentity,
} from "./identity.ts";
import { LinkClient } from "./link.ts";
import { log } from "./log.ts";
import { createServerFactory } from "./tools.ts";
import { baseOf, PublicUrls, resourceOf } from "./urls.ts";

export { log };

export interface RunningGateway {
  /** The first URL agents reach it at: its first public URL, else the listener. */
  url: string;
  /** The listener's own address, e.g. `http://127.0.0.1:7433`. */
  listener: string;
  /** Every URL it answers on, and which are registered. */
  urls: PublicUrls;
  gateway: Gateway;
  audit: LocalAuditLog;
  /** Linked mode only. */
  link?: LinkClient;
  /** Accepted TCP connections, e.g. to prove none come from the cloud. */
  server: { on(event: "connection", fn: (socket: unknown) => void): void };
  close(): Promise<void>;
}

/** How often retention runs, besides at start. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Delete events past retention now and every hour; returns a stop function. */
function startPruning(audit: LocalAuditLog, days: number): () => void {
  if (days <= 0) return () => {};
  const prune = () => {
    try {
      const gone = audit.prune(days);
      if (gone > 0) {
        log({ level: "info", msg: "audit events pruned", events: gone, days });
      }
    } catch (err) {
      log({ level: "warn", msg: "audit pruning failed", error: String(err) });
    }
  };
  prune();
  const timer = setInterval(prune, PRUNE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Open the audit log and every database, and read each catalog. Local mode
 * throws the first database's error (in config order) if any can't be
 * read; linked mode starts without those, as unreachable.
 */
async function openRuntime(
  config: BaseConfig,
  databases: Iterable<DatabaseConfig & { policy?: DatabasePolicy }>,
  mode: "local" | "linked",
  enforcement: Enforcement,
): Promise<{
  gateway: Gateway;
  audit: LocalAuditLog;
  executors: Map<string, DatabaseExecutor>;
  stopPruning: () => void;
}> {
  // A linked gateway owes each event to the cloud until it is acked.
  const audit = new LocalAuditLog(config.auditFile, {
    owed: mode === "linked",
  });
  if (audit.unsent > 0) {
    // They stay in the file, and aren't sent even if it is linked again.
    log({
      level: "warn",
      msg: "audit events recorded while linked never reached Midplane Cloud; local mode doesn't send them",
      events: audit.unsent,
    });
  }
  // Local mode keeps its log as it was: a database it can't read stops it.
  const health = new HealthBook({
    log: mode === "linked" ? log : () => {},
  });
  const executors = new Map<string, DatabaseExecutor>();
  const runtimes = new Map<string, DatabaseRuntime>();
  for (const db of databases) {
    const executor = new DatabaseExecutor(db.dsn, (attempt, kind) =>
      health.record(db.id, attempt, kind),
    );
    executors.set(db.id, executor);
    runtimes.set(db.id, {
      id: db.id,
      policy: db.policy ?? null,
      executor,
      catalog: null,
      refreshedAt: 0,
    });
  }
  const gateway = new Gateway({
    databases: runtimes,
    audit,
    // Linked mode keeps taint in the cloud, once the link is open.
    ...(mode === "local" ? { taint: localTaintStore(audit) } : {}),
    salt: config.maskSalt,
    limits: config.limits,
    mode,
    enforcement,
    health,
  });
  const failures = await gateway.readCatalogs();
  if (failures.length > 0 && mode === "local") {
    await Promise.all([...executors.values()].map((e) => e.close()));
    audit.close();
    throw failures[0];
  }
  const stopPruning = startPruning(audit, config.auditRetentionDays);
  return { gateway, audit, executors, stopPruning };
}

/** Listen with a handler that can be swapped in once the URLs are known. */
async function listen(
  config: BaseConfig,
  handler: () => Hono | null,
  onServer?: (server: RunningGateway["server"]) => void,
): Promise<{ server: ReturnType<typeof serve>; listener: string }> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve(
      {
        fetch: (req) =>
          handler()?.fetch(req) ??
          new Response("starting", {
            status: 503,
            headers: { "retry-after": "1" },
          }),
        hostname: config.listen.host,
        port: config.listen.port,
        ...(config.tls
          ? {
              createServer: createHttpsServer,
              serverOptions: { key: config.tls.key, cert: config.tls.cert },
            }
          : {}),
      },
      () => resolve(s),
    );
  });
  onServer?.(server);
  const address = server.address() as AddressInfo;
  const scheme = config.tls ? "https" : "http";
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { server, listener: `${scheme}://${host}:${address.port}` };
}

/** The URLs a gateway answers on: its public URLs, else its listener. */
function publicUrlsOf(config: BaseConfig, listener: string): PublicUrls {
  return new PublicUrls({
    configured: baseUrlsOf(config, listener).map(resourceOf),
    allowedHosts: config.allowedHosts,
    loopback: isLoopback(config.listen.host),
  });
}

function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive connections would hold close() open until they idle out.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

export async function startLocal(config: LocalConfig): Promise<RunningGateway> {
  const { gateway, audit, executors, stopPruning } = await openRuntime(
    config,
    config.databases.values(),
    "local",
    { state: "enforcing" },
  );
  let app: Hono | null = null;
  const { server, listener } = await listen(config, () => app);
  const urls = publicUrlsOf(config, listener);
  const verifier = new TokenVerifier({
    issuer: config.auth.issuer,
    audiences: () => urls.audiences(),
    project: config.project,
    key: config.auth.publicKey,
    revoked: config.auth.revoked,
  });
  app = buildApp({
    gateway,
    verifier,
    issuer: config.auth.issuer,
    urls,
    listenHost: config.listen.host,
    onClient: (client) => log({ level: "info", msg: "mcp client", ...client }),
  });
  log({
    level: "info",
    msg: "gateway listening",
    urls: urls.configured,
    mode: "local",
  });

  return {
    url: baseOf(urls.configured[0] as string),
    listener,
    urls,
    gateway,
    audit,
    server,
    async close() {
      stopPruning();
      await closeServer(server);
      await Promise.all([...executors.values()].map((e) => e.close()));
      audit.close();
    },
  };
}

/**
 * Local mode over stdio: the MCP client launches the gateway and passes a
 * token in MIDPLANE_TOKEN. It is verified at start and again on every call,
 * so an expired token stops working without a restart.
 */
export async function startLocalStdio(
  config: LocalConfig,
  token: string,
): Promise<void> {
  const audiences = baseUrlsOf(config).map(resourceOf);
  const verifier = new TokenVerifier({
    issuer: config.auth.issuer,
    audiences: () => audiences,
    project: config.project,
    key: config.auth.publicKey,
    revoked: config.auth.revoked,
  });
  await verifier.verify(token);
  const { gateway } = await openRuntime(
    config,
    config.databases.values(),
    "local",
    { state: "enforcing" },
  );
  serveStdio(
    createServerFactory(gateway, () => () => verifier.verify(token)),
    {
      legacy: "serve",
    },
  );
  log({ level: "info", msg: "gateway serving on stdio", mode: "local" });
}

/** The identity to run with: stored, or enrolled now for a file source. */
async function identityFor(
  config: LinkedConfig,
  resources: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<GatewayIdentity> {
  const stored = readIdentity(config.link.identity);
  if (stored) return stored;
  if (config.link.identity.kind !== "file") {
    throw new ConfigError("no identity"); // readIdentity threw already
  }
  const identity = await enroll({
    cloudUrl: config.link.cloudUrl,
    token: config.link.enrollmentToken(),
    resources,
    name: config.link.name,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  writeIdentity(config.link.identity.path, identity);
  log({
    level: "info",
    msg: "gateway enrolled",
    gateway: identity.gateway_id,
    project: identity.project_id,
    identity: config.link.identity.path,
  });
  return identity;
}

export interface LinkedOptions {
  /** For tests: the transport the link uses. */
  fetch?: typeof fetch;
  retry?: { minMs: number; maxMs: number; cutMs: number };
  /** For tests: how old a catalog may get before a sync re-reads it. */
  catalogMaxAgeMs?: number;
  /** Called once listening, before enrollment or any link traffic. */
  onServer?: (server: RunningGateway["server"]) => void;
  /** For tests: the audit push's delays. */
  auditTiming?: AuditPusherOptions["timing"];
}

/**
 * Linked mode: enforce bundles from Midplane Cloud. Until the first one
 * arrives (from the cache or the cloud), MCP answers 503 and nothing runs.
 * A database that can't be read at start doesn't stop it: the gateway
 * enrolls and syncs, reports it, and keeps trying it.
 */
export async function startLinked(
  config: LinkedConfig,
  options: LinkedOptions = {},
): Promise<RunningGateway> {
  const { gateway, audit, executors, stopPruning } = await openRuntime(
    config,
    config.databases.values(),
    "linked",
    {
      state: "waiting",
      reason: "it hasn't heard from the cloud since starting",
    },
  );
  let app: Hono | null = null;
  let link: LinkClient | null = null;
  const { server, listener } = await listen(
    config,
    () => app,
    options.onServer,
  );
  const urls = publicUrlsOf(config, listener);
  const close = async () => {
    stopPruning();
    // Retries stop now; one mid-read ends as its pool closes.
    const retries = gateway.close();
    await link?.close();
    await closeServer(server);
    await Promise.all([...executors.values()].map((e) => e.close()));
    await retries;
    audit.close();
  };

  try {
    const identity = await identityFor(config, urls.configured, options.fetch);
    if (identity.cloud_url !== config.link.cloudUrl) {
      throw new ConfigError(
        `this gateway enrolled with ${identity.cloud_url}, not ${config.link.cloudUrl}`,
      );
    }
    // Only URLs a bundle registers for this gateway are audiences; until
    // one arrives the gateway has no keys and answers nothing.
    const verifier = new TokenVerifier({
      issuer: identity.cloud_url,
      audiences: () => urls.audiences(),
      project: identity.project_id,
    });
    link = await LinkClient.open({
      identity,
      gateway,
      verifier,
      urls,
      executors,
      cachePath: config.link.bundleCache,
      audit,
      log,
      ...(options.auditTiming ? { auditTiming: options.auditTiming } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.catalogMaxAgeMs !== undefined
        ? { catalogMaxAgeMs: options.catalogMaxAgeMs }
        : {}),
    });
    gateway.useLink(link);
    app = buildApp({
      gateway,
      verifier,
      issuer: identity.cloud_url,
      urls,
      listenHost: config.listen.host,
      onClient: (client) =>
        log({ level: "info", msg: "mcp client", ...client }),
    });
    link.start();
    gateway.retryUnread();
    log({
      level: "info",
      msg: "gateway listening",
      urls: urls.configured,
      mode: "linked",
      project: identity.project_id,
      bundle: link.version,
    });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    url: baseOf(urls.configured[0] as string),
    listener,
    urls,
    gateway,
    audit,
    link,
    server,
    close,
  };
}

/** `midplane enroll`: enroll and return the identity, for a secret manager. */
export async function enrollOnly(
  config: LinkedConfig,
  fetchImpl?: typeof fetch,
): Promise<GatewayIdentity> {
  if (config.publicUrls.length === 0 && config.listen.port === 0) {
    throw new ConfigError(
      "enrolling needs the gateway's URLs: set public_urls or a fixed listen.port",
    );
  }
  return enroll({
    cloudUrl: config.link.cloudUrl,
    token: config.link.enrollmentToken(),
    resources: baseUrlsOf(config).map(resourceOf),
    name: config.link.name,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
