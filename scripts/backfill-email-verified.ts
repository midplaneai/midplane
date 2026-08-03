#!/usr/bin/env bun
// One-shot migration: grandfather pre-existing accounts past the new email
// verification gate.
//
// WHY THIS EXISTS
// ---------------
// emailAndPassword.requireEmailVerification (lib/auth.ts) blocks session
// creation until `user.email_verified` is true. That column has existed since
// the initial auth schema but nothing ever set it, so essentially every
// existing row is `false` — including the internal/test accounts.
//
// Deploying the gate without this script is a self-inflicted outage: every
// existing credential user, staff included, is locked out on the next sign-in
// with no way back in except the verification mail they never expected. These
// users signed up under a contract that didn't require verification; applying
// the new rule retroactively punishes them for our change.
//
// So: accounts created BEFORE the cutoff are grandfathered to verified. New
// signups after it go through the real flow. This is a deliberate trade — it
// trusts addresses that were never confirmed — which is why it is scoped by
// timestamp and supports an explicit exclusion list rather than blanket-setting
// the whole table. Anything you would not vouch for belongs in --exclude, or
// should be deleted before this runs.
//
// Google users are unaffected either way: Better Auth writes verified=true from
// the provider's claim.
//
// USAGE
//   # dry run (no writes) — prints every row it would touch
//   bun scripts/backfill-email-verified.ts eu
//   # exclude specific addresses (repeatable, case-insensitive)
//   bun scripts/backfill-email-verified.ts eu --exclude=25.just.testing@gmail.com
//   # apply
//   bun scripts/backfill-email-verified.ts eu --apply
//
// Run it once PER REGION (eu, us) — auth data is region-resident, never
// central. Reads DATABASE_URL_<REGION> from the environment; locally,
// `set -a; source .env.local; set +a` covers it.
//
// Cutoff defaults to now (everything currently in the table). Override with
// --cutoff=<ISO-8601> to be narrower.

import postgres from "postgres";

type Region = "eu" | "us";

const region = process.argv[2] as Region | undefined;
const apply = process.argv.includes("--apply");

const excludes = new Set(
  process.argv
    .filter((a) => a.startsWith("--exclude="))
    .map((a) => a.slice("--exclude=".length).trim().toLowerCase())
    .filter(Boolean),
);

const cutoffArg = process.argv.find((a) => a.startsWith("--cutoff="));
const cutoff = cutoffArg
  ? new Date(cutoffArg.slice("--cutoff=".length))
  : new Date();

if (region !== "eu" && region !== "us") {
  console.error(
    "usage: bun scripts/backfill-email-verified.ts <eu|us> [--apply] [--exclude=<email>] [--cutoff=<ISO>]",
  );
  process.exit(1);
}
if (Number.isNaN(cutoff.getTime())) {
  console.error(`invalid --cutoff (want ISO-8601): ${cutoffArg}`);
  process.exit(1);
}

const url = process.env[`DATABASE_URL_${region.toUpperCase()}`];
if (!url) {
  console.error(`DATABASE_URL_${region.toUpperCase()} is not set`);
  process.exit(1);
}

const sql = postgres(url, { prepare: false });

try {
  const rows = await sql<
    { id: string; email: string; createdAt: Date }[]
  >`
    SELECT id, email, created_at AS "createdAt"
    FROM "user"
    WHERE email_verified = false
      AND created_at < ${cutoff}
    ORDER BY created_at
  `;

  if (rows.length === 0) {
    console.log(`[${region}] nothing to do — no unverified rows before cutoff`);
    process.exit(0);
  }

  const targets = rows.filter((r) => !excludes.has(r.email.toLowerCase()));
  const skipped = rows.filter((r) => excludes.has(r.email.toLowerCase()));

  console.log(
    `[${region}] cutoff ${cutoff.toISOString()} — ${rows.length} unverified, ${targets.length} to verify, ${skipped.length} excluded`,
  );
  for (const r of skipped) {
    console.log(`  SKIP   ${r.email}  (excluded; stays unverified)`);
  }
  for (const r of targets) {
    console.log(
      `  VERIFY ${r.email}  (created ${r.createdAt.toISOString()})`,
    );
  }

  if (!apply) {
    console.log(`\n[${region}] dry run — re-run with --apply to write`);
    process.exit(0);
  }

  if (targets.length === 0) {
    console.log(`\n[${region}] every candidate was excluded; nothing written`);
    process.exit(0);
  }

  const ids = targets.map((r) => r.id);
  const updated = await sql`
    UPDATE "user"
       SET email_verified = true,
           updated_at = now()
     WHERE id IN ${sql(ids)}
       AND email_verified = false
    RETURNING id
  `;
  console.log(`\n[${region}] verified ${updated.length} account(s)`);
} finally {
  await sql.end();
}
