// Process-wide singletons backing the /mcp/<token>/[...path] proxy.
//
// The DecryptCache and ContainerRegistry must be shared across requests so
// the cache + idle timers + spawn-mutexes actually work. Next.js dev-server
// recompilation can reset module-level singletons, so we cache on globalThis
// in dev and rely on the steady-state module identity in prod.
//
// Backend selection:
//   MIDPLANE_SELF_HOST=1 → ProcessSpawner (exec the in-image compiled
//                          `midplane server` binary per connection on a
//                          loopback port — no Docker daemon, no Fly).
//   FLY_API_TOKEN set    → FlyMachineSpawner (production shape).
//   else                 → DockerSpawner (laptop / Playwright).
//
// The audit Indexer is also a singleton: started lazily on first proxy
// request, runs forever, drains every active container's SQLite into the
// cloud audit_events_index on a 5s cadence. Off when INDEXER_TOKEN is
// unset (dev convenience — OSS containers without the token don't expose
// the /audit endpoints anyway).
//
// PR2 of mcp_url_auth_security: ContainerRegistry keys on connection_id,
// not the plaintext mcp_token. The pushPolicy helper takes a connectionId.
// The ExpirySweeper runs alongside the Indexer in the regional process
// and flips expired-but-still-active rows on mcp_tokens.

import { randomUUID } from "node:crypto";

import {
  ContainerRegistry,
  DecryptCache,
  DockerSpawner,
  DsnResolver,
  dryRunPolicy,
  ExpirySweeper,
  FlyMachineSpawner,
  Indexer,
  loadRegions,
  ProcessSpawner,
  pushPolicy as pushPolicyHelper,
  type DryRunOutcome,
  type DryRunRequest,
  type PushPolicyResult,
  type Spawner,
  type SpawnOptions,
} from "@midplane-cloud/router";
import { getDb, type DatabaseEntry } from "@midplane-cloud/db";
import { makeKmsContext } from "@midplane-cloud/kms";

import { bootRegion } from "./region-context.ts";
import { isSelfHost } from "./self-host.ts";

interface McpProxyContext {
  cache: DecryptCache;
  registry: ContainerRegistry;
  resolver: DsnResolver;
  indexer: Indexer | null;
  expirySweeper: ExpirySweeper | null;
  /** Hot-reload a connection's table_access + tenant_scope.mappings on
   *  its running engine, if any. The body must list every DB the
   *  connection owns — DBs absent from the body are dropped from the
   *  engine's registry. Resolves to `delivered:false` when there is no
   *  active container OR `INDEXER_TOKEN` is unset (laptop dev); the
   *  next spawn will read the new policy from Postgres on its own. */
  pushPolicy(
    connectionId: string,
    databases: readonly DatabaseEntry[],
  ): Promise<PushPolicyResult>;
  /** Engine policy dry-run (acquire → push → /admin/dry-run) for the
   *  test panel. The engine takes exactly one of `probes` | `sql` per
   *  POST, so a run that needs both (probe matrix + guardrail SQL
   *  checks) passes the sequence and pays acquire + push once; verdicts
   *  come back concatenated in request order. engine_unavailable when
   *  `INDEXER_TOKEN` is unset — the engine's admin surface is 404 in
   *  that mode, so there is no verdict to be had (laptop dev without
   *  token plumbing). */
  dryRun(
    spawn: SpawnOptions,
    requests: readonly DryRunRequest[],
    /** Re-read of the policy entries right before the push — see
     *  DryRunDeps.freshEntries (a cold spawn makes the request-start
     *  snapshot stale enough to overwrite a concurrent save). */
    freshEntries?: () => Promise<DatabaseEntry[]>,
  ): Promise<DryRunOutcome>;
}

const GLOBAL_KEY = "__midplane_mcp_proxy__";

interface GlobalWithCtx {
  [GLOBAL_KEY]?: McpProxyContext;
}

export function getMcpProxyContext(): McpProxyContext {
  const g = globalThis as unknown as GlobalWithCtx;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];

  const cache = new DecryptCache();
  const regions = loadRegions(process.env);
  const flyApiToken = process.env.FLY_API_TOKEN;
  const selfHost = isSelfHost();

  // Audit pipeline bearer.
  //   Hosted (FLY_API_TOKEN set): REQUIRED — silent disablement there means
  //     audit data never reaches the dashboard with zero log signal until a
  //     customer notices.
  //   Self-host: AUTO-PROVISION a loopback-only token when unset. The engine
  //     is a local subprocess reachable only at 127.0.0.1, so the token never
  //     leaves the box; generating it means self-host audit works out of the
  //     box without the operator wiring yet another secret (and avoids the
  //     silent zero-audit-rows trap).
  //   Laptop Docker dev: optional, so the loop doesn't require token plumbing.
  let indexerToken = process.env.INDEXER_TOKEN;
  if (selfHost && !indexerToken) {
    indexerToken = randomUUID();
    console.log(
      "[mcp-proxy] self-host: auto-provisioned a loopback INDEXER_TOKEN for the audit pipeline (set INDEXER_TOKEN to override)",
    );
  }
  if (flyApiToken && !indexerToken) {
    throw new Error(
      "INDEXER_TOKEN is required when FLY_API_TOKEN is set (hosted audit pipeline cannot start without it)",
    );
  }

  const spawner: Spawner = selfHost
    ? new ProcessSpawner({ indexerToken })
    : flyApiToken
      ? new FlyMachineSpawner({
          apiToken: flyApiToken,
          regions,
          indexerToken,
        })
      : new DockerSpawner({ indexerToken });

  const registry = new ContainerRegistry(spawner);
  // Module-init: this runs once on first import (memoized on globalThis),
  // before any request scope exists. Read the region from process env.
  const db = getDb(bootRegion());
  const resolver = new DsnResolver({
    db,
    cache,
    kms: makeKmsContext(process.env),
  });

  let indexer: Indexer | null = null;
  if (indexerToken) {
    indexer = new Indexer({
      db,
      registry,
      indexerToken,
      onError: (err, ctx) => {
        // Audit indexing failures are operationally significant but not
        // fatal — log via console for now; the dashboard staleness banner
        // is the user-visible signal.
        console.error(
          "[indexer]",
          ctx.phase,
          ctx.connectionId.slice(0, 8),
          err,
        );
      },
    });
    indexer.start();
  }

  // Expiry sweeper runs alongside the indexer in the regional process.
  // Independent of indexerToken — even in laptop dev without the indexer
  // we want expired tokens to flip status so the dashboard renders
  // truthfully. Durable enforcement of expiry happens in resolveByToken
  // (NOW() in the WHERE filter); the sweeper is for dashboard /
  // audit ordering.
  const expirySweeper = new ExpirySweeper({
    db,
    onSweep: ({ affected }) => {
      console.log(`[expiry-sweeper] flipped ${affected} token(s) to expired`);
    },
    onError: (err) => {
      console.error("[expiry-sweeper]", err);
    },
  });
  expirySweeper.start();

  const pushPolicy = async (
    connectionId: string,
    databases: readonly DatabaseEntry[],
  ): Promise<PushPolicyResult> => {
    if (!indexerToken) return { delivered: false };
    return pushPolicyHelper(connectionId, databases, {
      registry,
      indexerToken,
    });
  };

  const dryRun = async (
    spawn: SpawnOptions,
    requests: readonly DryRunRequest[],
    freshEntries?: () => Promise<DatabaseEntry[]>,
  ): Promise<DryRunOutcome> => {
    if (!indexerToken) {
      return {
        ok: false,
        kind: "engine_unavailable",
        detail: "INDEXER_TOKEN unset — engine admin surface disabled",
      };
    }
    return dryRunPolicy(spawn, requests, {
      registry,
      indexerToken,
      freshEntries,
    });
  };

  const ctx: McpProxyContext = {
    cache,
    registry,
    resolver,
    indexer,
    expirySweeper,
    pushPolicy,
    dryRun,
  };
  g[GLOBAL_KEY] = ctx;
  return ctx;
}
