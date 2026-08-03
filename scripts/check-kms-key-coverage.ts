#!/usr/bin/env bun
// Pre-flight gate: would this env leave any stored DSN undecryptable?
//
// `decryptDsn` dispatches on the STORED `project_databases.kms_key_id`, not on
// MIDPLANE_KMS_MODE. So a row written in env-mode (`kms_key_id = 'env:<region>'`)
// needs MIDPLANE_KMS_DEV_KEY_<REGION> forever, regardless of the mode the region
// is running today. Flipping a region to kms-mode and dropping the dev key
// strands every such row: `credential_unavailable` on every agent query, with a
// green boot and a green KMS liveness probe (that one round-trips a FRESH
// encrypt, which proves nothing about existing rows).
//
// Run this BEFORE changing MIDPLANE_KMS_MODE or removing a key secret. Exits
// non-zero if any row would be stranded, and prints the remedy.
//
// Two different questions, checked two different ways — because decryptDsn
// treats the two key kinds asymmetrically:
//
//   env: rows  → need MIDPLANE_KMS_DEV_KEY_<REGION>. A STATIC env check
//                answers this completely.
//   CMK rows   → decryptKms is handed the row's OWN stored arn; the code never
//                reads MIDPLANE_KMS_KEY_<REGION> on the decrypt path (that var
//                is encrypt-side only). So no env inspection can tell you
//                whether a CMK row is readable — it depends on AWS credentials
//                and a kms:Decrypt grant on that specific arn. We PROBE: one
//                real decrypt per distinct arn.
//
// USAGE
//   set -a; source .env.local; set +a
//   bun scripts/check-kms-key-coverage.ts eu
//
// To model a PROPOSED env rather than the current one, unset the var you're
// about to drop:
//   MIDPLANE_KMS_DEV_KEY_EU= bun scripts/check-kms-key-coverage.ts eu
//
// Needs AWS credentials when CMK rows are present (for the probe). Plaintext is
// never printed and never leaves the process — only the fact that a decrypt
// succeeded.
//
// NOT COVERED: the token pepper. mcp_tokens.token_hash is a one-way HMAC, so a
// pepper swap is undetectable by inspection — it just makes existing machine
// tokens stop verifying. When moving a region to kms-mode, re-encrypt the
// EXISTING pepper under the CMK (scripts/encrypt-token-pepper.sh) rather than
// generating a new one.

import postgres from "postgres";

import { decryptEnv } from "../packages/kms/src/env-mode.ts";
import { decryptKms } from "../packages/kms/src/kms-mode.ts";

const region = process.argv[2];
if (region !== "eu" && region !== "us") {
  console.error("usage: bun scripts/check-kms-key-coverage.ts <eu|us>");
  process.exit(1);
}

const R = region.toUpperCase();
const dbUrl = process.env[`DATABASE_URL_${R}`];
if (!dbUrl) {
  console.error(`[kms-coverage] DATABASE_URL_${R} is not set`);
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });

// One sample row per distinct key id: the count drives the report, the sample
// is the probe subject for CMK arns (distinct on kms_key_id, cheapest row).
const rows = await sql<
  {
    kms_key_id: string;
    rows: number;
    sample_id: string;
    customer_id: string;
    encrypted_dsn: Buffer;
  }[]
>`
  select distinct on (d.kms_key_id)
         d.kms_key_id,
         count(*) over (partition by d.kms_key_id)::int as rows,
         d.id as sample_id,
         p.customer_id,
         d.encrypted_dsn
  from project_databases d
  join projects p on p.id = d.project_id
  where p.region = ${region}
  order by d.kms_key_id, d.id
`;
await sql.end();

if (rows.length === 0) {
  console.log(`[kms-coverage] region=${region}: no project_databases rows`);
  process.exit(0);
}

const failures: Array<{ kmsKeyId: string; rows: number; why: string }> = [];
console.log(
  `[kms-coverage] region=${region} mode=${process.env.MIDPLANE_KMS_MODE ?? "env (default)"}`,
);

for (const row of rows) {
  const label = `${row.kms_key_id} — ${row.rows} row${row.rows === 1 ? "" : "s"}`;
  const wire = Buffer.from(row.encrypted_dsn);

  if (row.kms_key_id.startsWith("env:")) {
    // Static answer: decryptDsn resolves these through MIDPLANE_KMS_DEV_KEY_<R>.
    const envKey = process.env[`MIDPLANE_KMS_DEV_KEY_${R}`];
    if (!envKey) {
      console.log(`  ✗ ${label} — MIDPLANE_KMS_DEV_KEY_${R} NOT SET`);
      failures.push({
        kmsKeyId: row.kms_key_id,
        rows: row.rows,
        why: `MIDPLANE_KMS_DEV_KEY_${R} is not set`,
      });
      continue;
    }
    // Key present — confirm it's the RIGHT key, not just any key.
    try {
      decryptEnv(wire, envKey, row.customer_id, region);
      console.log(`  ✓ ${label} — env key decrypts`);
    } catch (err) {
      console.log(`  ✗ ${label} — env key present but wrong`);
      failures.push({
        kmsKeyId: row.kms_key_id,
        rows: row.rows,
        why: `MIDPLANE_KMS_DEV_KEY_${R} does not decrypt this row: ${(err as Error).message}`,
      });
    }
    continue;
  }

  // CMK: no env var governs this. Probe the stored arn for real — that is the
  // only thing that answers "can production read these rows?".
  try {
    await decryptKms(wire, row.kms_key_id, row.customer_id, region);
    console.log(`  ✓ ${label} — kms:Decrypt probe OK`);
  } catch (err) {
    console.log(`  ✗ ${label} — kms:Decrypt probe FAILED`);
    failures.push({
      kmsKeyId: row.kms_key_id,
      rows: row.rows,
      why: (err as Error).message,
    });
  }
}

if (failures.length === 0) {
  console.log("[kms-coverage] every stored key id decrypts with this env");
  process.exit(0);
}

const affected = failures.reduce((n, s) => n + s.rows, 0);
console.error(
  `\n[kms-coverage] ${affected} row(s) are UNDECRYPTABLE — every agent query against them returns credential_unavailable.`,
);
for (const f of failures) {
  console.error(`  ${f.kmsKeyId}: ${f.why}`);
  if (f.kmsKeyId.startsWith("env:")) {
    console.error(
      `    → re-encrypt under the CMK:\n` +
        `      MIDPLANE_KMS_DEV_KEY_${R}=<retired key> bun scripts/reencrypt-env-mode-dsns.ts ${region} --apply`,
    );
  } else {
    console.error(
      `    → grant kms:Decrypt on this KEY ARN (not the alias arn) to the app's IAM identity`,
    );
  }
}
process.exit(1);
