// Boot-time migration runner baked into the self-host image (Dockerfile.self-host)
// and run by docker/self-host-entrypoint.sh before the web server starts.
//
// Unlike migrate.ts (the CWD-relative `bun run src/migrate.ts <target>` used from
// packages/db during from-source work), this has NO argv dependency and reads its
// migration files from an absolute, baked path — it is compiled with
// `bun build --compile` and copied onto PATH as `midplane-migrate`, so `process.argv`
// indices and the working directory are not stable. Config comes entirely from env:
//   DATABASE_URL    — the single self-host Postgres to migrate (required)
//   MIGRATIONS_DIR  — where the .sql files + meta/ live (default /app/migrations)
//
// Drizzle migrate is idempotent (it applies only journal entries newer than the
// last applied row), so re-running on every boot is safe. On any failure — DB
// unreachable, a migration statement erroring — it prints a readable message and
// exits non-zero so the entrypoint aborts boot loudly instead of serving against a
// half-migrated database.

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const url = process.env.DATABASE_URL;
const migrationsFolder = process.env.MIGRATIONS_DIR ?? "/app/migrations";

if (!url) {
  console.error(
    "[migrate] FATAL: DATABASE_URL is not set — cannot apply migrations.\n" +
      "          The bundled compose points this at the 'postgres' service; if you\n" +
      "          run the image directly, pass DATABASE_URL for your Postgres.",
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] migrations applied");
  await sql.end();
} catch (err) {
  console.error(
    "[migrate] FATAL: failed to apply migrations. The database may be\n" +
      "          unreachable, or a migration statement errored. The web server\n" +
      "          will NOT start against a half-migrated database.\n",
  );
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
