import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";
import type { Region } from "./schema.ts";

export * from "./schema.ts";
export * from "./policy.ts";
export * from "./token-format.ts";

// One pool per region. The original single-slot `cached` would let the first
// caller's region win the cache for the process lifetime (silent cross-region
// read). Deleting the cache entirely is also wrong: each `postgres(url)` call
// opens a fresh connection pool, so every request would leak a 10-conn pool.
// Per-region keying is the correct shape.
const cached = new Map<Region, ReturnType<typeof create>>();

// Self-host (MIDPLANE_SELF_HOST=1) runs against ONE Postgres and ignores the
// region argument. Read the flag inline: packages/db is the lowest layer, so it
// can't import the app's lib/self-host.ts seam without a dependency cycle —
// both just read the same env var. See apps/web/src/lib/self-host.ts for the
// canonical isSelfHost() + the SELF_HOST_REGION the app pins everything to.
function selfHost(): boolean {
  return process.env.MIDPLANE_SELF_HOST === "1";
}

// Cache key constant under self-host so getDb("eu") and getDb("us") return the
// SAME single-DB pool instead of opening two against one URL. Mirrors
// SELF_HOST_REGION; in practice the app only ever passes that region anyway.
const SELF_HOST_DB_KEY: Region = "eu";

export function getDb(region: Region) {
  const key: Region = selfHost() ? SELF_HOST_DB_KEY : region;
  const existing = cached.get(key);
  if (existing) return existing;
  const db = create(resolveDatabaseUrl(region));
  cached.set(key, db);
  return db;
}

function resolveDatabaseUrl(region: Region): string {
  if (selfHost()) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (self-host)");
    return url;
  }
  // Cloud: per-region locality. getDb('us') from the EU app THROWS when
  // DATABASE_URL_US is unset — the intentional cross-region guard. Preserved.
  const envVar = region === "eu" ? "DATABASE_URL_EU" : "DATABASE_URL_US";
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set`);
  return url;
}

function create(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Neon pgbouncer compatibility
  });
  return drizzle(sql, { schema });
}
