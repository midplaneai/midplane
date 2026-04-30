// MIDPLANE_DENY_WEBHOOK — fire a JSON POST on every policy denial.
//
// Wraps an AuditWriter so every DECIDED+DENY event triggers an out-of-band
// webhook. Generic JSON payload — Slack incoming webhooks, Discord, PagerDuty
// Events API, or any HTTP endpoint will accept it.
//
// Optional MIDPLANE_DENY_WEBHOOK_RULES filters by policy_rule name
// (comma-separated, e.g. "table_access,multi_statement").
//
// Fire-and-forget with a 5s timeout. Webhook failure NEVER fails or blocks
// an audit write — the DECIDED row is the source of truth, the webhook is
// a notification.

import type { AuditEvent, AuditWriter } from "@midplane/engine";
import { logger } from "./logger.ts";

const REQUEST_TIMEOUT_MS = 5_000;
const SQL_PREVIEW_MAX = 1024;
// Pending ATTEMPTED entries are dropped FIFO once this many are buffered.
// In practice DECIDED follows ATTEMPTED in the same handle() call, so the
// map stays at ~concurrency depth. The cap is only a safety net for the
// case where a DECIDED write fails before reaching us.
const PENDING_MAX = 256;
const USER_AGENT = "midplane-deny-webhook/1";

export interface DenyWebhookConfig {
  url: string;
  // undefined → fire on every rule. Defined → only fire if policy_rule is in set.
  rules?: Set<string>;
}

export function loadDenyWebhookConfig(
  env: NodeJS.ProcessEnv,
): DenyWebhookConfig | null {
  const url = env.MIDPLANE_DENY_WEBHOOK?.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `MIDPLANE_DENY_WEBHOOK must be an http:// or https:// URL`,
    );
  }
  const rulesRaw = env.MIDPLANE_DENY_WEBHOOK_RULES?.trim();
  if (!rulesRaw) return { url };
  const rules = new Set(
    rulesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (rules.size === 0) return { url };
  return { url, rules };
}

export interface DenyWebhookPayload {
  event: "denial";
  schema_version: 1;
  ts: number;
  query_id: string;
  audit_id: string;
  tenant_id: string;
  agent_identity: string | null;
  policy_rule: string;
  reason: string;
  statement_type: string | null;
  tables_touched: string[];
  // Empty string when the matching ATTEMPTED row was not observed
  // (e.g. evicted under load). Receivers should treat empty as "unknown".
  sql_preview: string;
  sql_truncated: boolean;
}

export interface Poster {
  post(payload: DenyWebhookPayload): Promise<void>;
}

// `log` is an internal seam so tests can assert the warning fires on a 4xx
// response without depending on pino's runtime level. Production callers use
// the default project logger.
export function createHttpPoster(
  url: string,
  log: { warn: (ctx: Record<string, unknown>, msg: string) => void } = logger,
): Poster {
  return {
    async post(payload) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
          keepalive: true,
        });
        if (!res.ok) {
          log.warn(
            { status: res.status, rule: payload.policy_rule },
            "deny webhook receiver returned non-2xx",
          );
        }
      } catch (err) {
        log.warn(
          { err: (err as Error).message, rule: payload.policy_rule },
          "deny webhook post failed",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface PendingSql {
  preview: string;
  truncated: boolean;
}

export class DenyWebhookAuditWriter implements AuditWriter {
  private readonly pendingSql = new Map<string, PendingSql>();
  private readonly poster: Poster;

  constructor(
    private readonly inner: AuditWriter,
    private readonly cfg: DenyWebhookConfig,
    poster?: Poster,
  ) {
    this.poster = poster ?? createHttpPoster(cfg.url);
  }

  async write(event: AuditEvent): Promise<void> {
    await this.inner.write(event);
    try {
      this.observe(event);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "deny webhook observer threw",
      );
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private observe(event: AuditEvent): void {
    if (event.event_type === "ATTEMPTED") {
      const raw = event.payload.sql_raw;
      const truncated = raw.length > SQL_PREVIEW_MAX;
      this.pendingSql.set(event.query_id, {
        preview: truncated ? raw.slice(0, SQL_PREVIEW_MAX) : raw,
        truncated,
      });
      if (this.pendingSql.size > PENDING_MAX) {
        const oldest = this.pendingSql.keys().next().value;
        if (oldest !== undefined) this.pendingSql.delete(oldest);
      }
      return;
    }

    if (event.event_type !== "DECIDED") return;

    // ALLOW or DENY: clear the buffer either way so a long-running install
    // never accumulates entries for queries that already finished.
    const pending = this.pendingSql.get(event.query_id);
    this.pendingSql.delete(event.query_id);

    if (event.payload.decision !== "DENY") return;

    if (this.cfg.rules && !this.cfg.rules.has(event.payload.policy_rule)) {
      return;
    }

    const payload: DenyWebhookPayload = {
      event: "denial",
      schema_version: 1,
      ts: event.ts,
      query_id: event.query_id,
      audit_id: event.id,
      tenant_id: event.tenant_id,
      agent_identity: event.agent_identity,
      policy_rule: event.payload.policy_rule,
      reason: event.payload.reason,
      statement_type: event.payload.statement_type ?? null,
      tables_touched: event.payload.tables_touched ?? [],
      sql_preview: pending?.preview ?? "",
      sql_truncated: pending?.truncated ?? false,
    };

    // Fire-and-forget. Any throw / rejection from a custom poster is
    // swallowed here so it never surfaces as an unhandled rejection or
    // disturbs the audit hot path. The HTTP poster already catches its
    // own fetch errors; this is a defense-in-depth catch for callers
    // that pass their own Poster.
    this.poster.post(payload).catch((err) => {
      logger.warn(
        { err: (err as Error).message, rule: payload.policy_rule },
        "deny webhook poster threw",
      );
    });
  }
}
