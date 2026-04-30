// Process-wide singletons backing the /mcp/<token>/[...path] proxy.
//
// The DecryptCache and ContainerRegistry must be shared across requests so
// the cache + idle timers + spawn-mutexes actually work. Next.js dev-server
// recompilation can reset module-level singletons, so we cache on globalThis
// in dev and rely on the steady-state module identity in prod.
//
// Backend selection:
//   FLY_API_TOKEN set → FlyMachineSpawner (production shape).
//   else            → DockerSpawner (laptop / Playwright).
//
// The audit Indexer is also a singleton: started lazily on first proxy
// request, runs forever, drains every active container's SQLite into the
// cloud audit_events_index on a 5s cadence. Off when INDEXER_TOKEN is
// unset (dev convenience — OSS containers without the token don't expose
// the /audit endpoints anyway).

import {
  ContainerRegistry,
  DecryptCache,
  DockerSpawner,
  DsnResolver,
  FlyMachineSpawner,
  Indexer,
  loadRegions,
} from "@midplane-cloud/router";
import { getDb } from "@midplane-cloud/db";
import { makeKmsContext } from "@midplane-cloud/kms";

interface McpProxyContext {
  cache: DecryptCache;
  registry: ContainerRegistry;
  resolver: DsnResolver;
  indexer: Indexer | null;
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
  const indexerToken = process.env.INDEXER_TOKEN;

  const spawner = process.env.FLY_API_TOKEN
    ? new FlyMachineSpawner({
        apiToken: process.env.FLY_API_TOKEN,
        regions,
        indexerToken,
      })
    : new DockerSpawner({ indexerToken });

  const registry = new ContainerRegistry(spawner);
  const db = getDb();
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
        console.error("[indexer]", ctx.phase, ctx.token.slice(0, 8), err);
      },
    });
    indexer.start();
  }

  const ctx: McpProxyContext = { cache, registry, resolver, indexer };
  g[GLOBAL_KEY] = ctx;
  return ctx;
}
