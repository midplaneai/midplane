// Cloud → engine policy dry-run: the verdict pipeline behind the
// dashboard's "test policy" panel. Computes allow/deny for probes or a
// custom SQL statement using the SAME engine that enforces at query
// time — never a cloud-side reimplementation (a second decision brain
// drifts; see the connections-ux design doc, premise P1).
//
//   acquire ──► pushPolicy ──► POST /admin/dry-run
//      │             │                │
//   spawn-on-     freshness        verdicts
//   demand        guarantee
//
// ORDER MATTERS (eng review, round-3 finding): do NOT gate on
// pushPolicy before acquire — `doPush` returns {delivered:false}
// whenever there is no active container, which is ALWAYS true on a
// cold engine; a pre-acquire gate deadlocks every cold start while
// passing warm-engine dev testing. After a successful acquire,
// {delivered:false} IS the refusal condition: a warm engine that
// missed the push would serve verdicts against stale policy — silent
// dishonesty on the trust surface itself.
//
// The engine endpoint ships in the OSS repo (contract pinned in the
// design doc). Against an older engine image, /admin/dry-run is 404 —
// surfaced as engine_unavailable with a detail naming the image gap.

import type { DatabaseEntry } from "@midplane-cloud/db";

import { pushPolicy, PushPolicyError } from "./admin.ts";
import type { ContainerRegistry, SpawnOptions } from "./spawner.ts";

export interface DryRunProbe {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  cross_tenant?: boolean;
}

/** Canonical request shape (design doc, ship sequence step 1). Exactly
 *  one of `probes` | `sql`. */
export interface DryRunRequest {
  database: string;
  tenant_context?: { value: string };
  probes?: DryRunProbe[];
  sql?: string;
}

export interface DryRunVerdict {
  probe?: DryRunProbe;
  sql?: string;
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
  tables: string[];
  action: string;
}

export interface DryRunResponse {
  verdicts: DryRunVerdict[];
  truncated: boolean;
  total_tables?: number;
}

export type DryRunOutcome =
  // Engine answered — verdicts in hand.
  | { ok: true; response: DryRunResponse }
  // Spawn failed, policy delivery failed post-acquire, timeout, 401/5xx,
  // or the engine image predates the endpoint. Retryable from the UI.
  | { ok: false; kind: "engine_unavailable"; detail?: string }
  // Engine rejected the request (bad SQL, unknown database, policy
  // rejected on push). Body is the engine's error — surface verbatim.
  | { ok: false; kind: "engine_rejected"; status: number; body: string };

export interface DryRunDeps {
  registry: ContainerRegistry;
  /** Same bearer the indexer + /admin/policy use. */
  indexerToken: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Engine-call timeout. Default 30s — covers a cold Fly spawn. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function dryRunPolicy(
  spawn: SpawnOptions,
  request: DryRunRequest,
  deps: DryRunDeps,
): Promise<DryRunOutcome> {
  // 1. acquire — spawn-on-demand. A fresh spawn reads policy from its
  //    SpawnOptions, so a cold start is policy-fresh by construction.
  let active: { host: string; port: number };
  try {
    active = await deps.registry.acquire(spawn);
  } catch (err) {
    return { ok: false, kind: "engine_unavailable", detail: message(err) };
  }

  // 2. pushPolicy AFTER acquire — the push-then-probe freshness
  //    guarantee for the warm-engine case.
  const entries: DatabaseEntry[] = spawn.databases.map((d) => ({
    name: d.name,
    connectionDatabaseId: d.connectionDatabaseId,
    tableAccess: d.tableAccess,
    tenantScope: d.tenantScope,
  }));
  try {
    const pushed = await pushPolicy(spawn.connectionId, entries, {
      registry: deps.registry,
      indexerToken: deps.indexerToken,
      fetch: deps.fetch,
    });
    if ("rejected" in pushed) {
      return {
        ok: false,
        kind: "engine_rejected",
        status: pushed.rejected.status,
        body: pushed.rejected.body,
      };
    }
    if (!pushed.delivered) {
      // Post-acquire false: container died between acquire and push, or
      // the engine lacks /admin/policy. Refuse rather than risk stale
      // verdicts.
      return {
        ok: false,
        kind: "engine_unavailable",
        detail: "policy delivery failed after spawn",
      };
    }
  } catch (err) {
    const detail =
      err instanceof PushPolicyError
        ? `policy push ${err.status}`
        : message(err);
    return { ok: false, kind: "engine_unavailable", detail };
  }

  // 3. The dry-run call itself.
  const fetchFn = deps.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetchFn(
      `http://${active.host}:${active.port}/admin/dry-run`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.indexerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: ctl.signal,
      },
    );
    if (res.status === 200) {
      const body = (await res.json()) as DryRunResponse;
      if (!body || !Array.isArray(body.verdicts)) {
        return {
          ok: false,
          kind: "engine_unavailable",
          detail: "malformed dry-run response",
        };
      }
      return { ok: true, response: body };
    }
    if (res.status === 404) {
      // Route absent — the pinned engine image predates dry-run.
      return {
        ok: false,
        kind: "engine_unavailable",
        detail: "engine image does not support dry-run yet",
      };
    }
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500 && res.status !== 401) {
      return { ok: false, kind: "engine_rejected", status: res.status, body: text };
    }
    return {
      ok: false,
      kind: "engine_unavailable",
      detail: `dry-run ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      kind: "engine_unavailable",
      detail: ctl.signal.aborted ? "engine timed out" : message(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
