// Run pending Drizzle migrations against DATABASE_URL.
// Usage: bun run src/migrate.ts

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });

console.log("migrations applied");
await sql.end();
