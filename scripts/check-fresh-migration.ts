#!/usr/bin/env bun
// Post-migration assertions for the fresh-DB migration gate (migrate-fresh.yml).
//
// The self-host install applies the whole migration chain (baseline 0000 + every
// later migration) on ONE connection against a brand-new Postgres. A regression
// where 0000's pg_dump preamble emptied the session search_path
// (`set_config('search_path', '', false)`) made every later, unqualified-name
// migration fail and rolled the batch back, leaving fresh DBs empty. This asserts
// the chain actually landed, so that regression can't silently return.
//
//   DATABASE_URL=... bun scripts/check-fresh-migration.ts

import postgres from "postgres";

import journal from "../packages/db/migrations/meta/_journal.json";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[check-fresh-migration] DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const [tbl] = await sql`
  select to_regclass('public.project_databases') is not null as exists
`;
const [mig] = await sql`
  select count(*)::int as count from drizzle.__drizzle_migrations
`;
await sql.end();

// Applied rows must match the number of journaled migrations — self-updating as
// migrations are added, and still catches a partial (rolled-back) apply.
const expected = journal.entries.length;
const errors: string[] = [];
if (!tbl?.exists) errors.push("public.project_databases is missing");
if (mig?.count !== expected) {
  errors.push(`expected ${expected} applied migrations (journal), found ${mig?.count}`);
}

if (errors.length > 0) {
  console.error("[check-fresh-migration] FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `[check-fresh-migration] OK: project_databases exists, ${mig.count}/${expected} migrations applied`,
);
