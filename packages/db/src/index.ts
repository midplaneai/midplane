import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

export * from "./schema.ts";
export * from "./policy.ts";

let cached: ReturnType<typeof create> | undefined;

export function getDb(databaseUrl: string = requireEnv("DATABASE_URL")) {
  if (!cached) cached = create(databaseUrl);
  return cached;
}

function create(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    prepare: false, // Neon pgbouncer compatibility
  });
  return drizzle(sql, { schema });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
