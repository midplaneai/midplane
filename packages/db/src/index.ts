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

export function getDb(region: Region) {
  const existing = cached.get(region);
  if (existing) return existing;
  const envVar = region === "eu" ? "DATABASE_URL_EU" : "DATABASE_URL_US";
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set`);
  const db = create(url);
  cached.set(region, db);
  return db;
}

function create(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Neon pgbouncer compatibility
  });
  return drizzle(sql, { schema });
}
