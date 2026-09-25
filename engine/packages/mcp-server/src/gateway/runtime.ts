// The gateway runtime: which policy this process enforces, and how it learns
// about the next one.
//
// Three states:
//
//   awaiting_bundle   never held an enforceable bundle. Every tool call is
//                     refused (and audited); no database connection exists.
//   serving           enforcing the newest authentic bundle.
//   halted            the newest authentic bundle can't be enforced here (a
//                     format or feature this gateway doesn't know, a policy
//                     that doesn't check out, or `paused`). Refuses like
//                     awaiting, pools drained, until a newer bundle applies.
//
// Every bundle — fetched, or read back from the state dir at boot — goes
// through the same pipeline: verify (signature, issuer, project, version floor)
// → persist if it came from the network → check the envelope and the policy →
// apply with full replacement. A bundle that fails VERIFICATION is rejected and
// changes nothing. One that verifies but can't be ENFORCED halts: keeping an
// older bundle the customer has already replaced would silently drop whatever
// the new one added.
//
// The cloud being unreachable changes nothing either: the last bundle stays in
// force, and the one on disk is what a restart comes back up with.

import { createHash, type KeyObject } from "node:crypto";
import { ulid } from "ulid";
import { TRANSFORM_NAMES, type AuditEvent } from "@midplane/engine";
import { ENGINE_FEATURES } from "../config.ts";
import type { BuiltEngineHandle, ReplaceDatabase } from "../engine-factory.ts";
import type { Availability, ServingGuard, ToolRefusal } from "../server.ts";
import { checkBundlePolicy } from "./policy-check.ts";
import {
  BUNDLE_FIELDS_V1,
  b64urlDecode,
  keyId,
  publicKeyFromRaw,
  verifyBundle,
  type BundleRejectReason,
} from "./protocol.ts";
import type { GatewaySigner, LinkClient } from "./link-client.ts";
import type { GatewayStateDir, StoredIdentity } from "./state.ts";

export type GatewayState = "awaiting_bundle" | "serving" | "halted";

export const LINK_CAPABILITIES = ["bundle.v1", "heartbeat.v1", "approval_gate.v1"] as const;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_BACKOFF_S = 300;
const REVOKED_POLL_S = 300;

export interface RuntimeLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export interface GatewayRuntimeDeps {
  identity: StoredIdentity;
  privateKey: KeyObject;
  state: GatewayStateDir;
  client: LinkClient;
  handle: BuiltEngineHandle;
  /** Where MIDPLANE_DSN_* values are read from (process.env in production). */
  env: NodeJS.ProcessEnv;
  pollSeconds: number;
  engineVersion: string;
  runtimeLabel: string;
  installShape: string;
  tenantId: string;
  log: RuntimeLogger;
}

interface Rejection {
  version: number | null;
  reason: BundleRejectReason;
  detail: string;
  at: string;
}

export class GatewayRuntime {
  private stateValue: GatewayState = "awaiting_bundle";
  private haltReason: string | null = null;
  /** Newest authentic bundle held (applied or halted on). The version floor. */
  private current: { version: number; jws: string } | null = null;
  private applied: { version: number; policySha256: string; appliedAt: string } | null = null;
  private lastRejection: Rejection | null = null;
  private persistError: string | null = null;
  private pendingPersist: string | null = null;
  private revoked = false;
  private failures = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly signer: GatewaySigner;
  private readonly bundleKey: KeyObject;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatQueued = false;
  private started = false;
  /** Serializes bundle processing: a poll and a boot load never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GatewayRuntimeDeps) {
    const { identity } = deps;
    const raw = b64urlDecode(identity.signing_key.x);
    if (keyId(raw) !== identity.signing_key.kid) {
      throw new Error("identity.json signing key does not match its kid; delete the state directory and enroll again");
    }
    this.bundleKey = publicKeyFromRaw(raw);
    this.signer = { gatewayId: identity.gateway_id, audience: identity.issuer, privateKey: deps.privateKey };
  }

  get state(): GatewayState {
    return this.stateValue;
  }

  /** The signer the approval gate and every link request use. */
  get requestSigner(): GatewaySigner {
    return this.signer;
  }

  // ── boot + loop ─────────────────────────────────────────────────────────

  /** Re-verify and apply whatever the state dir holds. Not trusted: a cached
   *  bundle that fails verification leaves the gateway awaiting. */
  async bootFromCache(): Promise<void> {
    const cached = this.deps.state.readBundle();
    if (cached === null) {
      this.deps.log.info({}, "no cached policy bundle; serving nothing until Midplane Cloud answers");
      return;
    }
    await this.process(cached, "cache");
  }

  /** One poll. Returns what happened, for tests and logs. */
  async pollOnce(): Promise<"not_modified" | "bundle" | "error"> {
    this.retryPendingPersist();
    const res = await this.deps.client.fetchBundle(this.signer, this.current?.version ?? null);
    if (res.kind === "error") {
      this.failures += 1;
      this.noteLinkFailure(res.status, res.code, res.message, res.serverTime);
      return "error";
    }
    this.failures = 0;
    this.revoked = false;
    if (res.kind === "not_modified") return "not_modified";
    await this.process(res.jws, "cloud");
    return "bundle";
  }

  async sendHeartbeat(): Promise<boolean> {
    const res = await this.deps.client.heartbeat(this.signer, this.heartbeat());
    if (res.kind === "error") {
      this.noteLinkFailure(res.status, res.code, `heartbeat: ${res.message}`, res.serverTime);
      return false;
    }
    return true;
  }

  start(): void {
    this.started = true;
    this.schedulePoll(0);
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  // ── what the transport and the tool surface ask ─────────────────────────

  availability(): Availability {
    switch (this.stateValue) {
      case "serving":
        return { ok: true };
      case "awaiting_bundle":
        return {
          ok: false,
          reason:
            "This gateway has not received a policy from Midplane Cloud yet, so it serves nothing. Check the gateway's logs and its card on the project page in Midplane Cloud.",
        };
      case "halted":
        return { ok: false, reason: `This gateway is not serving: ${this.haltReason}` };
    }
  }

  health(): { status: number; body: unknown } {
    if (this.stateValue === "serving") {
      return { status: 200, body: { ok: true, state: "serving", bundle_version: this.applied?.version ?? null } };
    }
    return {
      status: 503,
      body: { ok: false, state: this.stateValue, ...(this.haltReason ? { reason: this.haltReason } : {}) },
    };
  }

  /** The guard buildServer runs before every tool call. Refusals are decisions,
   *  so each one gets a DECIDED/DENY audit row, like any policy denial. */
  servingGuard(): ServingGuard {
    return {
      check: () => this.availability(),
      onRefused: (r) => this.auditRefusal(r),
    };
  }

  heartbeat(): Record<string, unknown> {
    return {
      engine_version: this.deps.engineVersion,
      runtime: this.deps.runtimeLabel,
      install_shape: this.deps.installShape,
      started_at: this.startedAt,
      state: this.stateValue,
      halt_reason: this.haltReason,
      capabilities: {
        link: [...LINK_CAPABILITIES],
        bundle_fields: [...BUNDLE_FIELDS_V1],
        policy_features: [...ENGINE_FEATURES].sort(),
        mask_transforms: [...TRANSFORM_NAMES],
      },
      bundle: this.applied
        ? { version: this.applied.version, policy_sha256: this.applied.policySha256, applied_at: this.applied.appliedAt }
        : null,
      newest_version: this.current?.version ?? null,
      last_rejection: this.lastRejection,
      persist_error: this.persistError,
      // Policy only: DSN variable NAMES and whether they're set, never values.
      databases: this.deps.handle.policySnapshot(),
    };
  }

  // ── the pipeline ────────────────────────────────────────────────────────

  private process(jws: string, source: "cache" | "cloud"): Promise<void> {
    const run = this.chain.then(() => this.processNow(jws, source));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async processNow(jws: string, source: "cache" | "cloud"): Promise<void> {
    const { identity, log } = this.deps;
    const verdict = verifyBundle(jws, {
      signer: { kid: identity.signing_key.kid, publicKey: this.bundleKey },
      issuer: identity.issuer,
      projectId: identity.project_id,
      current: this.current,
      minVersion: identity.min_version,
    });

    if (verdict.kind === "noop") return;
    if (verdict.kind === "reject") {
      this.lastRejection = {
        version: verdict.version,
        reason: verdict.reason,
        detail: verdict.detail,
        at: new Date().toISOString(),
      };
      log[source === "cache" ? "error" : "warn"](
        { source, reason: verdict.reason, version: verdict.version, detail: verdict.detail },
        source === "cache"
          ? "cached policy bundle failed verification; ignoring it"
          : "rejected a policy bundle; enforcement unchanged",
      );
      this.queueHeartbeat();
      return;
    }

    // Authentic and newer. Keep it — on disk too — before deciding whether it
    // can be enforced, so a restart re-decides on THIS bundle, never an older one.
    if (source === "cloud") this.persist(jws);
    this.current = { version: verdict.version, jws };
    const v = verdict.version;

    if (!verdict.envelope.ok) return this.halt(v, verdict.envelope.reason);
    const claims = verdict.envelope.claims;
    if (verdict.envelope.ignoredFields.length > 0) {
      log.debug({ version: v, fields: verdict.envelope.ignoredFields }, "bundle carries fields this gateway ignores");
    }
    const checked = checkBundlePolicy(claims.policy);
    if (!checked.ok) return this.halt(v, `policy bundle v${v} can't be enforced by this gateway: ${checked.reason}`);
    if (claims.paused) return this.halt(v, "this project is paused in Midplane Cloud");

    const databases: ReplaceDatabase[] = checked.databases.map((d) => {
      const dsn = this.deps.env[d.dsnEnv];
      const configured = typeof dsn === "string" && dsn.length > 0;
      return { spec: { ...d.spec, url: configured ? dsn : "" }, dsnEnv: d.dsnEnv, configured };
    });
    try {
      await this.deps.handle.replacePolicy(databases, { bundleVersion: v });
    } catch (err) {
      return this.halt(v, `policy bundle v${v} could not be applied: ${(err as Error).message}`);
    }

    this.stateValue = "serving";
    this.haltReason = null;
    this.applied = {
      version: v,
      policySha256: createHash("sha256").update(claims.policy, "utf8").digest("hex"),
      appliedAt: new Date().toISOString(),
    };
    const unconfigured = databases.filter((d) => !d.configured).map((d) => `${d.spec.name} (${d.dsnEnv})`);
    log.info({ version: v, source, databases: databases.length }, "policy bundle applied");
    if (unconfigured.length > 0) {
      log.warn({ databases: unconfigured }, "databases without a DSN variable refuse every call until it is set");
    }
    this.queueHeartbeat();
  }

  private async halt(version: number, reason: string): Promise<void> {
    this.stateValue = "halted";
    this.haltReason = reason;
    this.applied = null;
    this.deps.log.error({ version, reason }, "gateway halted: serving nothing until a newer bundle applies");
    // Nothing reaches the engine while halted (the guard refuses first); drain
    // the pools anyway so a halted gateway holds no database connections.
    try {
      await this.deps.handle.replacePolicy([], { bundleVersion: version });
    } catch (err) {
      this.deps.log.warn({ err }, "draining databases on halt failed");
    }
    this.queueHeartbeat();
  }

  private persist(jws: string): void {
    try {
      this.deps.state.writeBundle(jws);
      this.persistError = null;
      this.pendingPersist = null;
    } catch (err) {
      // Apply anyway — the new bundle is what the customer wants enforced — and
      // keep retrying the write, so a restart can't fall back to the older file.
      this.persistError = (err as Error).message;
      this.pendingPersist = jws;
      this.deps.log.error({ err: this.persistError }, "could not persist the policy bundle; will retry");
    }
  }

  private retryPendingPersist(): void {
    if (this.pendingPersist !== null) this.persist(this.pendingPersist);
  }

  private noteLinkFailure(status: number | null, code: string | null, message: string, serverTime: number | null): void {
    const { log } = this.deps;
    if (code === "gateway_revoked") {
      if (!this.revoked) {
        log.error(
          {},
          "Midplane Cloud revoked this gateway. It keeps enforcing its last policy; held writes can't be approved. Stop it, or enroll it again.",
        );
      }
      this.revoked = true;
      return;
    }
    if (code === "clock_skew") {
      const skew = serverTime !== null ? Math.round(Date.now() / 1000 - serverTime) : null;
      log.error({ skew_seconds: skew }, "Midplane Cloud rejected this gateway's clock; fix the host's time sync");
      return;
    }
    log.warn({ status, code }, message);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.started) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        this.deps.log.error({ err: (err as Error).message }, "poll failed");
      }
      this.schedulePoll(this.nextDelayMs());
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private nextDelayMs(): number {
    const base = this.revoked ? REVOKED_POLL_S : this.deps.pollSeconds;
    const backedOff = this.failures > 0 ? Math.min(base * 2 ** this.failures, MAX_BACKOFF_S) : base;
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(backedOff * jitter * 1000);
  }

  private queueHeartbeat(): void {
    if (!this.started || this.heartbeatQueued) return;
    this.heartbeatQueued = true;
    setTimeout(() => {
      this.heartbeatQueued = false;
      void this.sendHeartbeat();
    }, 0).unref?.();
  }

  private async auditRefusal(r: ToolRefusal): Promise<void> {
    const event = {
      id: ulid(),
      query_id: ulid(),
      tenant_id: this.deps.tenantId,
      database: r.database ?? "*",
      agent_name: r.agentName,
      agent_version: r.agentVersion,
      agent_intent: r.intent,
      mcp_token_id: null,
      ts: Date.now(),
      schema_version: 3,
      event_type: "DECIDED",
      payload: { decision: "DENY", policy_rule: "gateway_state", reason: r.reason, tool: r.tool },
    } as unknown as AuditEvent;
    await this.deps.handle.registry.audit.write(event);
  }
}
