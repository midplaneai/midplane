// Cloud → engine policy dry-run: the verdict pipeline behind the
// dashboard's "test policy" panel. Computes allow/deny for probes or a
// custom SQL statement using the SAME engine that enforces at query
// time — never a cloud-side reimplementation (a second decision brain
// drifts; see the projects-ux design doc, premise P1).
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
import { safeErrorDetail } from "./db-error.ts";
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
  /** Hash of the policy the engine evaluated against (0.9.0). Identical
   *  across the calls of one sequence — the policy doesn't change between
   *  them — so the merge keeps the last one seen. */
  policy_hash?: string;
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
  /** Re-read the policy entries from the durable store immediately
   *  before the push. The spawn snapshot can be a minute old by then (a
   *  cold spawn takes up to 60s), and the per-project push mutex
   *  orders by ENQUEUE time, not snapshot freshness — pushing the stale
   *  snapshot would overwrite a save committed during the window on the
   *  LIVE enforcement engine. Optional: callers without a durable
   *  re-read fall back to the spawn snapshot. */
  freshEntries?: () => Promise<DatabaseEntry[]>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function dryRunPolicy(
  spawn: SpawnOptions,
  // One engine call per request — the engine accepts exactly one of
  // `probes` | `sql` per POST, so a panel run that also checks guardrail
  // statements (each its own single-statement `sql` request) passes the
  // whole sequence here and pays acquire + push ONCE. Verdicts come back
  // concatenated in request order. All-or-nothing: any failed call fails
  // the run (partial verdicts on the trust surface would be dishonest).
  requests: readonly DryRunRequest[],
  deps: DryRunDeps,
): Promise<DryRunOutcome> {
  if (requests.length === 0) {
    return {
      ok: false,
      kind: "engine_unavailable",
      detail: "no dry-run requests",
    };
  }
  // 1. acquire — spawn-on-demand. A fresh spawn reads policy from its
  //    SpawnOptions, so a cold start is policy-fresh by construction.
  let active: { host: string; port: number };
  try {
    active = await deps.registry.acquire(spawn);
  } catch (err) {
    return { ok: false, kind: "engine_unavailable", detail: message(err) };
  }

  // 2. pushPolicy AFTER acquire — the push-then-probe freshness
  //    guarantee for the warm-engine case. Entries come from
  //    deps.freshEntries when available so a save committed during the
  //    acquire window can't be overwritten by our older snapshot.
  let entries: DatabaseEntry[];
  try {
    entries = deps.freshEntries
      ? await deps.freshEntries()
      : spawn.databases.map((d) => ({
          name: d.name,
          projectDatabaseId: d.projectDatabaseId,
          tableAccess: d.tableAccess,
          tenantScope: d.tenantScope,
          guardrails: d.guardrails,
        }));
  } catch (err) {
    return { ok: false, kind: "engine_unavailable", detail: message(err) };
  }
  try {
    const pushed = await pushPolicy(spawn.projectId, entries, {
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

  // 3. The dry-run calls themselves — sequential, so verdict order
  //    matches request order and we never fan out engine work. The
  //    timeout is PER CALL, not per sequence: the budget was sized for
  //    one engine answer, and a guardrails-on run is six calls — a slow
  //    engine that answers the big matrix call in 20s must not have the
  //    five cheap single-statement calls aborted by a shared clock.
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const merged: DryRunResponse = { verdicts: [], truncated: false };
  let ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const request of requests) {
      clearTimeout(timer);
      ctl = new AbortController();
      const signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetchFn(
        `http://${active.host}:${active.port}/admin/dry-run`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${deps.indexerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal,
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
        merged.verdicts.push(...body.verdicts);
        merged.truncated = merged.truncated || body.truncated === true;
        if (body.total_tables !== undefined) {
          merged.total_tables = body.total_tables;
        }
        if (body.policy_hash !== undefined) {
          if (
            merged.policy_hash !== undefined &&
            merged.policy_hash !== body.policy_hash
          ) {
            // A hot-reload landed between two calls of this sequence —
            // the verdicts in hand describe DIFFERENT policies. Merging
            // them would present a mixed result as one coherent answer
            // on the trust surface; fail the run instead (retryable).
            return {
              ok: false,
              kind: "engine_unavailable",
              detail: "policy changed mid-run",
            };
          }
          merged.policy_hash = body.policy_hash;
        }
        continue;
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
    }
    return { ok: true, response: merged };
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

// The `detail` carrier for unexpected failures. Driver/network errors collapse
// to an opaque class so a DB host or a Postgres "relation … does not exist"
// (with its table name) never rides out in `detail`; our own thrown messages
// (e.g. "project disappeared during dry-run") pass through unchanged.
function message(err: unknown): string {
  return safeErrorDetail(err);
}
