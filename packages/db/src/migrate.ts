// Run pending Drizzle migrations against one target's database URL.
//   bun run src/migrate.ts <eu|us>     → cloud region (DATABASE_URL_<REGION>)
//   bun run src/migrate.ts self-host   → single-tenant self-host (DATABASE_URL)

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const target = process.argv[2];
let url: string | undefined;
let label: string;
if (target === "self-host") {
  url = process.env.DATABASE_URL;
  label = "self-host";
} else if (target === "eu" || target === "us") {
  url = process.env[target === "eu" ? "DATABASE_URL_EU" : "DATABASE_URL_US"];
  label = target;
} else {
  console.error("usage: migrate.ts <eu|us|self-host>");
  process.exit(1);
}

if (!url) {
  console.error(
    target === "self-host"
      ? "DATABASE_URL is not set"
      : `DATABASE_URL_${(target as string).toUpperCase()} is not set`,
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });

console.log(`[${label}] migrations applied`);
await sql.end();
