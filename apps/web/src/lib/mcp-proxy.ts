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

import {
  ContainerRegistry,
  DecryptCache,
  DockerSpawner,
  DsnResolver,
  FlyMachineSpawner,
  loadRegions,
} from "@midplane-cloud/router";
import { getDb } from "@midplane-cloud/db";
import { makeKmsContext } from "@midplane-cloud/kms";

interface McpProxyContext {
  cache: DecryptCache;
  registry: ContainerRegistry;
  resolver: DsnResolver;
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

  const spawner = process.env.FLY_API_TOKEN
    ? new FlyMachineSpawner({
        apiToken: process.env.FLY_API_TOKEN,
        regions,
      })
    : new DockerSpawner();

  const registry = new ContainerRegistry(spawner);
  const resolver = new DsnResolver({
    db: getDb(),
    cache,
    kms: makeKmsContext(process.env),
  });

  const ctx: McpProxyContext = { cache, registry, resolver };
  g[GLOBAL_KEY] = ctx;
  return ctx;
}
