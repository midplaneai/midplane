// The link client: the gateway's only channel to Midplane Cloud, and always
// opened from this side. It authenticates as its own OAuth client
// (client_credentials with private_key_jwt), then long-polls for bundles and
// commands. Nothing listens for the cloud.
//
// The newest authentic bundle is written to disk before it takes effect, so
// a restart with the cloud down enforces it again, halts again, or stays
// paused, exactly as before the restart.
//
// Every sync reports the URLs the gateway's config names; each bundle says
// which are registered for it, and those are the token audiences it takes.
//
// The link also carries held writes and taint: the gateway files a held
// write, claims it once a person approved it, and checks or records a
// grant's taint. The answers it acts on are signed with the bundle key.
//
// And it pushes the audit log: each event once it is durable, on a loop of
// its own (audit-push.ts), with each sync's status naming the file's head.
// The cloud's ack is signed too, so only the cloud can make the gateway
// stop owing an event.
//
// The status says how each database answers. When one the gateway couldn't
// read at start is read at last, its catalog goes up at once, and the long
// poll is cut short so the cloud hears it is served.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { loadParser, redactCatalog } from "@midplane/core";
import {
  type ApprovalOutcome,
  ApprovalStateSchema,
  AuditAckSchema,
  type AuditBatch,
  approvalPath,
  approvalsPath,
  auditPath,
  CATALOG_UPLOAD_MAX_BYTES,
  type CatalogHashes,
  type CatalogSnapshot,
  ClaimAnswerSchema,
  ClaimRefusalSchema,
  type ClaimRequest,
  type Command,
  type CommandResult,
  CountPreviewPayloadSchema,
  catalogUploadPath,
  type FileApprovalRequest,
  FiledApprovalSchema,
  type GatewayStatus,
  grantTaintPath,
  LINK_API_PREFIX,
  LINK_SCOPE,
  linkResource,
  type RefreshCatalogResult,
  SYNC_WAIT_MS,
  SyncResponseSchema,
  TaintAnswerSchema,
  type TaintPayload,
  type TestConnectionResult,
  taintPath,
} from "@midplane/protocol";
import { importJWK, SignJWT } from "jose";
import {
  type Approvals,
  type Claimed,
  type Filed,
  relayed,
  type State,
  type TaintCheck,
  type TaintSource,
  type TaintStore,
  TaintUnavailableError,
} from "./approvals.ts";
import type { LocalAuditLog } from "./audit.ts";
import {
  AuditAckError,
  AuditPusher,
  type AuditPusherOptions,
  type PushAnswer,
} from "./audit-push.ts";
import type { TokenVerifier } from "./auth.ts";
import {
  type Assessment,
  assessBundle,
  type BundleContext,
  type Held,
  verifyBundle,
  verifyFreshness,
} from "./bundle.ts";
import type { DatabaseExecutor } from "./executor.ts";
import type { Gateway } from "./gateway.ts";
import { GATEWAY_FEATURES, type GatewayIdentity } from "./identity.ts";
import type { Logger } from "./log.ts";
import {
  type ProofContext,
  verifyAuditAck,
  verifyClaim,
  verifyDecision,
  verifyTaint,
} from "./proofs.ts";
import { SERVER_VERSION } from "./tools.ts";
import type { PublicUrls } from "./urls.ts";

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** The cloud refused this gateway's credentials: it was revoked. */
class LinkCutError extends Error {
  override name = "LinkCutError";
}

/** The cloud refused to file a held write, and said why. */
export class FilingRefusedError extends Error {
  override name = "FilingRefusedError";
}

/** A signed answer the gateway would act on didn't verify. */
export class ProofError extends Error {
  override name = "ProofError";
}

/** Taint calls sit on an agent's query: a slow cloud counts as unreachable. */
const TAINT_TIMEOUT_MS = 5_000;
const APPROVAL_TIMEOUT_MS = 10_000;

const nonce = () => randomBytes(16).toString("base64url");

export interface LinkClientOptions {
  identity: GatewayIdentity;
  gateway: Gateway;
  verifier: TokenVerifier;
  /** The URLs the gateway answers on; bundles say which are registered. */
  urls: PublicUrls;
  executors: ReadonlyMap<string, Pick<DatabaseExecutor, "probe">>;
  /** Where the newest authentic bundle is kept across restarts. */
  cachePath: string;
  log: Logger;
  fetch?: typeof fetch;
  /** Retry delays after a failed sync, in milliseconds. */
  retry?: { minMs: number; maxMs: number; cutMs: number };
  /** Re-read a catalog this old before a sync; five minutes by default. */
  catalogMaxAgeMs?: number;
  /** The audit file whose events this link pushes. */
  audit?: LocalAuditLog;
  /** For tests: the audit push's delays. */
  auditTiming?: AuditPusherOptions["timing"];
}

const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A body sent byte for byte, because its hash is taken over those bytes. */
class JsonText {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A database's catalog as the cloud may see it: redacted, serialized, hashed. */
interface CatalogUpload {
  body: JsonText;
  sha256: string;
  bytes: number;
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Write a file so a crash leaves the old contents or the new, never half. */
function writeDurably(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class LinkClient implements TaintStore, Approvals {
  private readonly o: LinkClientOptions;
  private readonly f: typeof fetch;
  private readonly cloud: string;
  private readonly bundleKey: BundleContext["key"];
  private held: Held | null = null;
  private rejected: GatewayStatus["rejected"] = null;
  private tokenEndpoint: { url: string; issuer: string } | null = null;
  private token: { value: string; expiresAt: number } | null = null;
  /** A token request in flight, shared by every call that needs one. */
  private minting: Promise<string> | null = null;
  /** Each command's result until the cloud has it, then "posted". */
  private readonly results = new Map<string, CommandResult | "posted">();
  /** Each catalog's upload, prepared once per read. */
  private readonly uploads = new WeakMap<CatalogSnapshot, CatalogUpload>();
  /** Per database, the hash last sent or refused: not sent again. */
  private readonly sent = new Map<string, string>();
  /** Per database, the withheld views last logged. */
  private readonly withheld = new Map<string, string>();
  private readonly stopper = new AbortController();
  private loop: Promise<void> | null = null;
  /** The long poll in flight, which news from this side cuts short. */
  private poll: AbortController | null = null;
  /** News since this sync's status was taken: sync again without a pause. */
  private nudged = false;
  /**
   * Databases whose statements go up as written, from the newest authentic
   * bundle; empty without one, or with one this gateway can't enforce.
   */
  private fullText: ReadonlySet<string> = new Set();
  private readonly pusher: AuditPusher | null;

  private constructor(o: LinkClientOptions, bundleKey: BundleContext["key"]) {
    this.o = o;
    this.f = o.fetch ?? fetch;
    this.cloud = o.identity.cloud_url;
    this.bundleKey = bundleKey;
    const audit = o.audit;
    this.pusher = audit
      ? new AuditPusher({
          audit,
          context: {
            fullText: (database) => this.fullText.has(database),
            catalog: (database) =>
              o.gateway.catalogs().find((c) => c.id === database)?.catalog ??
              null,
            attempted: (queryId) => audit.attempted(queryId),
            checkpoint: (hash) => audit.checkpoint(hash),
          },
          send: (batch) => this.pushAudit(batch),
          log: o.log,
          ...(o.auditTiming ? { timing: o.auditTiming } : {}),
        })
      : null;
  }

  /** A client for this identity, enforcing the cached bundle if there is one. */
  static async open(o: LinkClientOptions): Promise<LinkClient> {
    const key = (await importJWK(
      o.identity.bundle_key,
      "EdDSA",
    )) as BundleContext["key"];
    await loadParser();
    const client = new LinkClient(o, key);
    await client.loadCache();
    return client;
  }

  /** The version of the newest authentic bundle held, if any. */
  get version(): number | null {
    return this.held?.version ?? null;
  }

  status(nonce: string = randomBytes(16).toString("base64url")): GatewayStatus {
    const e = this.o.gateway.enforcement;
    return {
      bundle_version: this.held?.version ?? null,
      state: e.state,
      reason: "reason" in e ? truncate(e.reason) : null,
      rejected: this.rejected,
      version: SERVER_VERSION,
      features: [...GATEWAY_FEATURES],
      databases: this.o.gateway.configuredIds,
      resources: [...this.o.urls.configured],
      nonce,
      catalogs: Object.fromEntries(
        this.o.gateway
          .catalogs()
          .map(({ id, catalog }) => [id, this.upload(id, catalog).sha256]),
      ),
      ...this.auditHead(),
      database_health: this.o.gateway.health(),
    };
  }

  /**
   * The audit file's head for the status, its hash keyed as the cloud holds
   * them; left out if it can't be read.
   */
  private auditHead(): Pick<GatewayStatus, "audit"> {
    if (!this.o.audit) return {};
    try {
      const head = this.o.audit.head();
      return {
        audit: { ...head, hash: this.o.audit.checkpoint(head.hash) },
      };
    } catch (err) {
      this.o.log({
        level: "warn",
        msg: "audit head unavailable",
        error: String(err),
      });
      return {};
    }
  }

  /** Whether a database's statements go up as written. */
  sendsFullText(database: string): boolean {
    return this.fullText.has(database);
  }

  /**
   * POST one batch of audit records. Its ack counts only with a proof for
   * this nonce and these very bytes, from this gateway's file, naming the
   * hash of a record this batch carried; any other answer throws, and the
   * batch goes again. A proof naming a conflict, a record the cloud holds
   * under another hash, says the file forked there.
   */
  private async pushAudit(batch: AuditBatch): Promise<PushAnswer> {
    const n = nonce();
    // Serialized once: the ack must name the hash of the bytes posted.
    const body = new JsonText(JSON.stringify(batch));
    const res = await this.call(
      `${auditPath}?nonce=${n}`,
      body,
      60_000,
      [400, 404, 413, 429],
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status };
    }
    // A 200 that isn't JSON (a proxy's page) is an answer that didn't
    // verify; a body cut off on the way (a reset, the timeout) is an outage.
    const answer = AuditAckSchema.safeParse(
      await res.json().catch((err: unknown) => {
        if (err instanceof SyntaxError) return undefined;
        throw err;
      }),
    );
    const ack = answer.success
      ? await verifyAuditAck(answer.data.proof, {
          ...this.proofs,
          gatewayId: this.o.identity.gateway_id,
          instance: batch.instance,
          nonce: n,
          bodySha256: sha256(body.text),
        })
      : null;
    if (!ack || ack.acked !== answer.data?.acked) {
      throw new AuditAckError("Midplane Cloud's audit answer didn't verify");
    }
    // An ack below the batch acks nothing new; one inside it must name
    // the very event sent at that sequence.
    if (ack.acked >= (batch.records[0]?.seq ?? 0)) {
      const sent = batch.records.find((r) => r.seq === ack.acked);
      if (!sent || sent.hash !== ack.hash) {
        throw new AuditAckError("Midplane Cloud's audit answer didn't verify");
      }
    }
    if (ack.conflict) {
      // The cloud got this batch, and holds another event at one of its
      // sequences: it stored the records before it, and none from there.
      const { seq, hash } = ack.conflict;
      const sent = batch.records.find((r) => r.seq === seq);
      if (!sent || sent.hash === hash || ack.acked >= seq) {
        throw new AuditAckError("Midplane Cloud's audit answer didn't verify");
      }
      return { ok: false, forked: seq, acked: ack.acked };
    }
    return { ok: true, acked: ack.acked };
  }

  private async loadCache(): Promise<void> {
    let jws: string;
    try {
      jws = readFileSync(this.o.cachePath, "utf8").trim();
    } catch {
      return;
    }
    const outcome = await this.receive(jws, { cached: true });
    if (outcome === "rejected") {
      this.o.log({
        level: "warn",
        msg: "cached bundle ignored",
        reason: this.rejected?.reason,
      });
    }
  }

  /**
   * Take a bundle from the cloud (or the cache): verify it, keep it if it is
   * authentic and newer, then enforce it, pause, or halt. From the cloud it
   * must also be `latest`, the version its sync's freshness proof names.
   */
  async receive(
    jws: string,
    options: { cached?: boolean; latest?: number | null } = {},
  ): Promise<"applied" | "repeat" | "rejected"> {
    const verified = await verifyBundle(jws, {
      key: this.bundleKey,
      issuer: this.cloud,
      projectId: this.o.identity.project_id,
      floor: this.o.identity.bundle_floor,
      held: this.held,
    });
    if (verified.kind === "repeat") return "repeat";
    if (verified.kind === "rejected") {
      this.rejected = {
        version: verified.version,
        reason: truncate(verified.reason),
        sha256: sha256(jws),
      };
      if (!options.cached) {
        this.o.log({
          level: "warn",
          msg: "bundle rejected",
          version: verified.version,
          reason: verified.reason,
        });
      }
      return "rejected";
    }
    if (!options.cached && verified.version !== options.latest) {
      // Not recorded as a rejection: the cloud would stop sending its latest
      // bundle if an interrupted proof made the gateway refuse it once.
      this.o.log({
        level: "warn",
        msg: "bundle refused",
        version: verified.version,
        reason:
          options.latest == null
            ? "the answer carried no valid freshness proof"
            : `the project's latest bundle is version ${options.latest}`,
      });
      return "rejected";
    }
    if (!options.cached) {
      try {
        writeDurably(this.o.cachePath, verified.jws);
      } catch (err) {
        // Enforcement matters more than the cache, but the old cache must
        // not come back after a restart: without one, the gateway waits.
        this.o.log({
          level: "error",
          msg: "bundle cache write failed",
          error: String(err),
        });
        try {
          rmSync(this.o.cachePath, { force: true });
        } catch (rmErr) {
          this.o.log({
            level: "error",
            msg: "stale bundle cache could not be removed",
            error: String(rmErr),
          });
        }
      }
    }
    this.held = { version: verified.version, jws: verified.jws };
    await this.apply(
      verified.version,
      assessBundle(verified.raw, {
        databases: new Set(this.o.gateway.configuredIds),
        hasSalt: this.o.gateway.hasSalt,
        gatewayId: this.o.identity.gateway_id,
      }),
    );
    return "applied";
  }

  private async apply(version: number, a: Assessment): Promise<void> {
    const { gateway, verifier, urls, log } = this.o;
    if (a.kind !== "halt") {
      try {
        await verifier.setKeys(
          a.payload.jwks,
          new Set(a.payload.revoked_tokens),
        );
        // An older bundle lists no URLs: the one this gateway enrolled with.
        urls.register(a.resources ?? [this.o.identity.resource]);
        const unregistered = urls.unregistered();
        if (unregistered.length > 0) {
          log({
            level: "warn",
            msg: "public URL not registered",
            urls: unregistered,
            reason:
              "a project manager registers it on the project page, unless another gateway holds it",
          });
        }
      } catch (err) {
        a = {
          kind: "halt",
          reason: `the bundle's token keys can't be used (${(err as Error).message}).`,
        };
      }
    }
    // Only a bundle this gateway can read and enforce turns full statements on.
    this.fullText = new Set(
      a.kind === "halt" ? [] : (a.payload.audit?.full_text ?? []),
    );
    switch (a.kind) {
      case "halt":
        gateway.suspend({ state: "halted", reason: a.reason });
        log({
          level: "error",
          msg: "gateway halted",
          version,
          reason: a.reason,
        });
        return;
      case "paused":
        gateway.suspend({ state: "paused" });
        log({ level: "info", msg: "project paused", version });
        return;
      case "enforce":
        gateway.enforce(a.policies, version);
        log({
          level: "info",
          msg: "bundle enforced",
          version,
          databases: [...a.policies.keys()],
        });
        return;
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  /** Start long-polling, and pushing the audit log, in the background. */
  start(): void {
    this.o.gateway.whenFirstRead((id) => void this.firstRead(id));
    if (!this.loop) this.loop = this.run();
    this.pusher?.start();
  }

  /** Sync again at once: cut the long poll short, or skip the pause before the next. */
  private nudge(): void {
    this.nudged = true;
    this.poll?.abort();
  }

  /**
   * A database read for the first time is served now: upload its catalog
   * straight away, then sync, so the cloud hears it answers.
   */
  private async firstRead(id: string): Promise<void> {
    try {
      const catalog = this.o.gateway
        .catalogs()
        .find((c) => c.id === id)?.catalog;
      if (!catalog) return;
      const u = this.upload(id, catalog);
      if (this.sent.get(id) !== u.sha256) await this.send(id, u);
    } catch (err) {
      // The next sync uploads it, as for any catalog the cloud lacks.
      if (this.stopper.signal.aborted) return;
      this.o.log({
        level: "warn",
        msg: "catalog upload failed",
        database: id,
        error: (err as Error).message,
      });
    } finally {
      this.nudge();
    }
  }

  async close(): Promise<void> {
    this.stopper.abort();
    await Promise.all([this.loop, this.pusher?.close()]);
  }

  private async run(): Promise<void> {
    const retry = this.o.retry ?? {
      minMs: 1_000,
      maxMs: 30_000,
      cutMs: 60_000,
    };
    let failures = 0;
    while (!this.stopper.signal.aborted) {
      try {
        const started = Date.now();
        const busy = await this.syncOnce();
        failures = 0;
        // A cloud answering empty at once would otherwise spin this loop.
        if (!busy && Date.now() - started < retry.minMs) {
          await sleep(retry.minMs, this.stopper.signal);
        }
      } catch (err) {
        if (this.stopper.signal.aborted) break;
        failures++;
        const cut = err instanceof LinkCutError;
        const delay = cut
          ? retry.cutMs
          : Math.min(retry.maxMs, retry.minMs * 2 ** (failures - 1)) *
            (0.75 + Math.random() / 2);
        this.o.log({
          level: "warn",
          msg: cut ? "link cut" : "sync failed",
          error: (err as Error).message,
          retry_ms: Math.round(delay),
        });
        await sleep(delay, this.stopper.signal);
      }
    }
  }

  /**
   * One long poll. True when the cloud sent something that took effect, or
   * when this side has news for the cloud (the poll was cut short for it).
   */
  async syncOnce(): Promise<boolean> {
    this.nudged = false;
    await this.o.gateway.refreshStale(
      this.o.catalogMaxAgeMs ?? CATALOG_MAX_AGE_MS,
    );
    const nonce = randomBytes(16).toString("base64url");
    const poll = new AbortController();
    this.poll = poll;
    let answer: unknown;
    try {
      const res = await this.call(
        "/sync",
        this.status(nonce),
        SYNC_WAIT_MS + 20_000,
        [],
        poll.signal,
      );
      answer = await res.json();
    } catch (err) {
      if (poll.signal.aborted && !this.stopper.signal.aborted) return true;
      throw err;
    } finally {
      this.poll = null;
    }
    const body = SyncResponseSchema.safeParse(answer);
    if (!body.success) throw new Error("the cloud's sync answer is malformed");
    let took = false;
    if (body.data.bundle) {
      const latest = await verifyFreshness(body.data.freshness, {
        key: this.bundleKey,
        issuer: this.cloud,
        projectId: this.o.identity.project_id,
        nonce,
      });
      took = (await this.receive(body.data.bundle, { latest })) === "applied";
    }
    let worked = false;
    for (const command of body.data.commands) {
      worked = (await this.run1(command)) || worked;
    }
    await this.sendCatalogs(body.data.catalogs);
    // A bundle refused again, or a command already answered, is no news:
    // don't come straight back for it.
    return took || worked || this.nudged;
  }

  /** POST a link call with a current access token; one retry on a 401. */
  private call(
    path: string,
    body: unknown,
    timeoutMs = 30_000,
    also: readonly number[] = [],
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request("POST", path, body, timeoutMs, also, signal);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    also: readonly number[] = [],
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.f(`${this.cloud}${LINK_API_PREFIX}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? {
              body: body instanceof JsonText ? body.text : JSON.stringify(body),
            }
          : {}),
        signal: AbortSignal.any([
          this.stopper.signal,
          AbortSignal.timeout(timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        this.token = null;
        continue;
      }
      if (!res.ok && !also.includes(res.status)) {
        await res.body?.cancel();
        throw new Error(`${path} answered ${res.status}`);
      }
      return res;
    }
  }

  private async discover(): Promise<{ url: string; issuer: string }> {
    if (this.tokenEndpoint) return this.tokenEndpoint;
    const res = await this.f(
      `${this.cloud}/.well-known/oauth-authorization-server`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok)
      throw new Error(`authorization server metadata: ${res.status}`);
    const meta = (await res.json()) as {
      issuer?: unknown;
      token_endpoint?: unknown;
    };
    if (meta.issuer !== this.cloud || typeof meta.token_endpoint !== "string") {
      throw new Error(
        "the cloud's authorization server metadata doesn't match it",
      );
    }
    // Client assertions go only to the cloud this gateway enrolled with.
    if (new URL(meta.token_endpoint).origin !== this.cloud) {
      throw new Error("the token endpoint is on another origin");
    }
    this.tokenEndpoint = { url: meta.token_endpoint, issuer: meta.issuer };
    return this.tokenEndpoint;
  }

  /** A link access token: client_credentials, authenticated by private_key_jwt. */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) {
      return Promise.resolve(this.token.value);
    }
    // Queries share one request, rather than each minting its own.
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const endpoint = await this.discover();
    const id = this.o.identity;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(id.client_id)
      .setSubject(id.client_id)
      .setAudience(endpoint.issuer)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(await importJWK(id.key, "EdDSA"));
    const res = await this.f(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id.client_id,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: assertion,
        scope: LINK_SCOPE,
        resource: linkResource(this.cloud),
      }),
      signal: AbortSignal.any([
        this.stopper.signal,
        AbortSignal.timeout(30_000),
      ]),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    } | null;
    if (!res.ok || typeof body?.access_token !== "string") {
      const why =
        typeof body?.error_description === "string"
          ? `the token endpoint said ${relayed(body.error_description)}`
          : `token endpoint answered ${res.status}`;
      if (body?.error === "invalid_client") throw new LinkCutError(why);
      throw new Error(why);
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 60;
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + ttl * 1000,
    };
    return this.token.value;
  }

  // ── catalogs ─────────────────────────────────────────────────────────────

  /**
   * A catalog read as the cloud may see it, prepared once per read. Views
   * whose definitions are withheld are logged whenever that set changes.
   */
  private upload(id: string, catalog: CatalogSnapshot): CatalogUpload {
    let u = this.uploads.get(catalog);
    if (u) return u;
    const { catalog: redacted, withheld } = redactCatalog(catalog);
    const text = JSON.stringify(redacted);
    u = {
      body: new JsonText(text),
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
    };
    this.uploads.set(catalog, u);
    const names = withheld.map((w) => `${w.schema}.${w.name}`);
    if ((this.withheld.get(id) ?? "") !== names.join(",")) {
      this.withheld.set(id, names.join(","));
      if (withheld.length > 0) {
        this.o.log({
          level: "warn",
          msg: "view definitions withheld from the cloud",
          database: id,
          views: withheld.map((w, i) => ({ view: names[i], reason: w.reason })),
        });
      }
    }
    return u;
  }

  /** Upload each catalog whose hash the cloud doesn't hold, once per hash. */
  private async sendCatalogs(held: CatalogHashes): Promise<void> {
    for (const { id, catalog } of this.o.gateway.catalogs()) {
      const u = this.upload(id, catalog);
      if (held[id] === u.sha256 || this.sent.get(id) === u.sha256) continue;
      await this.send(id, u);
    }
  }

  /**
   * POST one catalog. A refusal (too large, unknown database, invalid) is
   * final for this hash; anything else throws, and the next sync retries.
   */
  private async send(
    id: string,
    u: CatalogUpload,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    let out: { ok: true } | { ok: false; code: string } = { ok: true };
    if (u.bytes > CATALOG_UPLOAD_MAX_BYTES) {
      out = { ok: false, code: "too_large" };
    } else {
      const res = await this.call(
        catalogUploadPath(encodeURIComponent(id)),
        u.body,
        120_000,
        [400, 404, 413],
      );
      await res.body?.cancel();
      if (!res.ok) out = { ok: false, code: `http_${res.status}` };
    }
    this.sent.set(id, u.sha256);
    if (!out.ok) {
      this.o.log({
        level: "warn",
        msg: "catalog upload refused",
        database: id,
        code: out.code,
        bytes: u.bytes,
      });
    }
    return out;
  }

  /** Re-read every catalog and send each, whatever the cloud holds. */
  private async refreshCatalogs(): Promise<RefreshCatalogResult> {
    const databases: RefreshCatalogResult["databases"] = {};
    for (const id of this.o.gateway.configuredIds) {
      const read = await this.o.gateway.rereadCatalog(id);
      if (!read.ok) {
        databases[id] = { ok: false, sha256: null, code: read.code };
        continue;
      }
      const u = this.upload(id, read.catalog);
      try {
        const sent = await this.send(id, u);
        databases[id] = {
          ok: sent.ok,
          sha256: u.sha256,
          code: sent.ok ? null : sent.code,
        };
      } catch {
        databases[id] = { ok: false, sha256: u.sha256, code: "unreachable" };
      }
    }
    return { databases };
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * Run a command once per process and report its result, keeping the
   * result until the cloud has it. True when it did something new.
   */
  private async run1(command: Command): Promise<boolean> {
    let result = this.results.get(command.id);
    if (result === "posted") return false;
    if (!result) {
      try {
        switch (command.kind) {
          case "test_connection":
            result = { ok: true, result: await this.testConnection() };
            break;
          case "refresh_catalog":
            result = { ok: true, result: await this.refreshCatalogs() };
            break;
          case "count_preview": {
            const payload = CountPreviewPayloadSchema.safeParse(
              command.payload,
            );
            result = payload.success
              ? {
                  ok: true,
                  result: await this.o.gateway.recount(
                    payload.data.approval_id,
                  ),
                }
              : { ok: false, error: "failed" };
            break;
          }
          default:
            result = { ok: false, error: "unsupported" };
        }
      } catch {
        result = { ok: false, error: "failed" };
      }
      this.results.set(command.id, result);
      if (this.results.size > 1000) {
        const [oldest] = this.results.keys();
        if (oldest) this.results.delete(oldest);
      }
    }
    // A failed POST throws and the sync backs off; the result is retried.
    // 404: the command expired or was answered; either way, it's done.
    const res = await this.call(
      `/commands/${encodeURIComponent(command.id)}`,
      result,
      30_000,
      [404],
    );
    await res.body?.cancel();
    this.results.set(command.id, "posted");
    return true;
  }

  // ── taint ────────────────────────────────────────────────────────────────

  private get proofs(): ProofContext {
    return {
      key: this.bundleKey,
      issuer: this.cloud,
      projectId: this.o.identity.project_id,
    };
  }

  /** The grant's taint as the cloud holds it; unknown on any doubt. */
  async checkTaint(grantId: string): Promise<TaintCheck> {
    const n = nonce();
    try {
      const res = await this.request(
        "GET",
        `${grantTaintPath(grantId)}?nonce=${n}`,
        undefined,
        TAINT_TIMEOUT_MS,
      );
      const proof = await this.verifiedTaint(res, grantId, n);
      if (proof) return proof.tainted ? "tainted" : "clean";
      this.o.log({
        level: "warn",
        msg: "taint answer didn't verify; the grant counts as tainted",
      });
    } catch (err) {
      this.o.log({
        level: "warn",
        msg: "taint check failed; the grant counts as tainted",
        error: (err as Error).message,
      });
    }
    return "unknown";
  }

  /** Record the grant's taint in the cloud; throws unless the cloud confirms it. */
  async taint(
    grantId: string,
    source: TaintSource,
    queryId: string,
  ): Promise<void> {
    const n = nonce();
    let confirmed = false;
    try {
      const res = await this.call(
        taintPath,
        { grant_id: grantId, source, query_id: queryId, nonce: n },
        TAINT_TIMEOUT_MS,
      );
      const proof = await this.verifiedTaint(res, grantId, n);
      confirmed = proof?.tainted === true;
    } catch (err) {
      throw new TaintUnavailableError((err as Error).message);
    }
    if (!confirmed) {
      throw new TaintUnavailableError(
        "the cloud's answer didn't confirm the taint",
      );
    }
  }

  /** The cloud's taint answer, verified for this grant and nonce; else null. */
  private async verifiedTaint(
    res: Response,
    grantId: string,
    nonce: string,
  ): Promise<TaintPayload | null> {
    const body = TaintAnswerSchema.safeParse(await res.json());
    if (!body.success) return null;
    return verifyTaint(body.data.proof, { ...this.proofs, grantId, nonce });
  }

  // ── approvals ────────────────────────────────────────────────────────────

  async file(request: FileApprovalRequest): Promise<Filed> {
    const res = await this.call(
      approvalsPath,
      request,
      30_000,
      [400, 403, 404, 413, 429],
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error_description?: unknown;
      } | null;
      throw new FilingRefusedError(
        typeof body?.error_description === "string"
          ? `it said ${relayed(body.error_description)}`
          : `the cloud answered ${res.status}`,
      );
    }
    const body = FiledApprovalSchema.safeParse(await res.json());
    if (!body.success)
      throw new Error("the cloud's filing answer is malformed");
    // The agent is sent only to this gateway's own cloud.
    return { ...body.data, review_url: this.reviewUrl(body.data.id) };
  }

  async claim(
    id: string,
    request: Omit<ClaimRequest, "nonce">,
    expect: { database: string },
  ): Promise<Claimed> {
    const n = nonce();
    const res = await this.call(
      `${approvalPath(id)}/claim`,
      { ...request, nonce: n },
      APPROVAL_TIMEOUT_MS,
      [409],
    );
    if (res.status === 409) {
      const refusal = ClaimRefusalSchema.safeParse(await res.json());
      if (!refusal.success)
        throw new Error("the cloud's claim refusal is malformed");
      return { ok: false, status: refusal.data.status };
    }
    const body = ClaimAnswerSchema.safeParse(await res.json());
    if (!body.success) throw new ProofError("the cloud's claim is malformed");
    const claimed = await verifyClaim(body.data.claim, {
      ...this.proofs,
      approvalId: id,
      nonce: n,
    });
    // Still claimable by this gateway's clock and by the cloud's, as it
    // signed the claim: a clock running behind doesn't stretch a window.
    const decision =
      claimed &&
      (await verifyDecision(body.data.decision, {
        ...this.proofs,
        approvalId: id,
        database: expect.database,
        approvalKey: request.approval_key,
        grantId: request.grant_id,
        now: Math.max(Date.now(), claimed.iat * 1000),
      }));
    if (!decision) {
      this.o.log({
        level: "warn",
        msg: "approval didn't verify; nothing ran",
        approval: id,
      });
      throw new ProofError(
        "Midplane Cloud's approval of this write didn't verify",
      );
    }
    return {
      ok: true,
      preview: decision.preview,
      decidedBy: decision.decided_by,
    };
  }

  async outcome(id: string, outcome: ApprovalOutcome): Promise<void> {
    const res = await this.call(
      `${approvalPath(id)}/outcome`,
      outcome,
      APPROVAL_TIMEOUT_MS,
      [404, 409],
    );
    await res.body?.cancel();
  }

  async state(id: string, grantId: string): Promise<State | null> {
    const res = await this.request(
      "GET",
      `${approvalPath(id)}?grant_id=${encodeURIComponent(grantId)}`,
      undefined,
      APPROVAL_TIMEOUT_MS,
      [404],
    );
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    const body = ApprovalStateSchema.safeParse(await res.json());
    if (!body.success) throw new Error("the cloud's answer is malformed");
    return { ...body.data, review_url: this.reviewUrl(body.data.id) };
  }

  /** Where a person reviews a request: on the cloud this gateway enrolled with. */
  private reviewUrl(id: string): string {
    return `${this.cloud}/approvals/${encodeURIComponent(id)}`;
  }

  private async testConnection(): Promise<TestConnectionResult> {
    const entries = await Promise.all(
      [...this.o.executors].map(async ([id, executor]) => {
        const p = await executor.probe();
        return [
          id,
          { ok: p.ok, latency_ms: Math.round(p.latencyMs), code: p.code },
        ] as const;
      }),
    );
    return { databases: Object.fromEntries(entries) };
  }
}
