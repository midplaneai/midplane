// Run pending Drizzle migrations against one region's DATABASE_URL.
// Usage: bun run src/migrate.ts <eu|us>

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const region = process.argv[2];
if (region !== "eu" && region !== "us") {
  console.error("usage: migrate.ts <eu|us>");
  process.exit(1);
}

const envVar = region === "eu" ? "DATABASE_URL_EU" : "DATABASE_URL_US";
const url = process.env[envVar];
if (!url) {
  console.error(`${envVar} is not set`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });

console.log(`[${region}] migrations applied`);
await sql.end();
