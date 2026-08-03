#!/usr/bin/env bun
// One-shot migration: re-encrypt bootstrap env-mode DSNs under the region's CMK.
//
// WHY THIS EXISTS
// ---------------
// decryptDsn() branches on the STORED `project_databases.kms_key_id`, not on
// MIDPLANE_KMS_MODE (packages/kms/src/index.ts). A row written while the region
// ran in env mode carries `kms_key_id = 'env:<region>'` and stays bound to
// MIDPLANE_KMS_DEV_KEY_<REGION> forever — so flipping the region to kms mode and
// dropping the dev key strands every such row: DsnResolver refuses with
// `credential_unavailable` and the agent's every query fails, with no boot-time
// warning (the env key is only read on a cache miss, deep inside a try/catch).
//
// This script closes that gap: decrypt each stranded row with the old env key,
// re-encrypt with the region CMK, verify the round-trip, and update the row.
//
// USAGE
//   # dry run (no writes) — prints what would change
//   MIDPLANE_KMS_DEV_KEY_EU=... bun scripts/reencrypt-env-mode-dsns.ts eu
//   # apply
//   MIDPLANE_KMS_DEV_KEY_EU=... bun scripts/reencrypt-env-mode-dsns.ts eu --apply
//
// Reads DATABASE_URL_<REGION>, MIDPLANE_KMS_KEY_<REGION> (CMK ARN/alias) and
// MIDPLANE_KMS_DEV_KEY_<REGION> (the retired 32-byte hex key) from the
// environment — `set -a; source .env.local; set +a` covers all three locally.
// Needs AWS credentials with kms:GenerateDataKey + kms:Decrypt on the CMK.
//
// Plaintext DSNs are never printed. Each row is verified by decrypting the NEW
// ciphertext back through the CMK and comparing to the original before the
// UPDATE lands, so a row is only rewritten once it is provably readable by the
// path production actually uses.
//
// AFTERWARDS: restart the region's web app (`fly machine restart`) so no process
// holds a stale DecryptCache entry — the cache is keyed by project-database id
// and a direct SQL update doesn't fire the rotation invalidation hook.

import postgres from "postgres";

import { decryptEnv } from "../packages/kms/src/env-mode.ts";
import { decryptKms, encryptKms } from "../packages/kms/src/kms-mode.ts";
import type { Region } from "../packages/kms/src/types.ts";

const region = process.argv[2] as Region | undefined;
const apply = process.argv.includes("--apply");

if (region !== "eu" && region !== "us") {
  console.error("usage: bun scripts/reencrypt-env-mode-dsns.ts <eu|us> [--apply]");
  process.exit(1);
}

const R = region.toUpperCase();
const dbUrl = process.env[`DATABASE_URL_${R}`];
const cmk = process.env[`MIDPLANE_KMS_KEY_${R}`];
const envKey = process.env[`MIDPLANE_KMS_DEV_KEY_${R}`];

const missing = [
  !dbUrl && `DATABASE_URL_${R}`,
  !cmk && `MIDPLANE_KMS_KEY_${R}`,
  !envKey && `MIDPLANE_KMS_DEV_KEY_${R}`,
].filter(Boolean);
if (missing.length > 0) {
  console.error(`[reencrypt] missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const sql = postgres(dbUrl!, { max: 1, prepare: false });

const rows = await sql<
  {
    id: string;
    name: string;
    project_name: string;
    customer_id: string;
    encrypted_dsn: Buffer;
  }[]
>`
  select d.id, d.name, p.name as project_name, p.customer_id, d.encrypted_dsn
  from project_databases d
  join projects p on p.id = d.project_id
  where d.kms_key_id = ${`env:${region}`}
  order by d.created_at
`;

console.log(
  `[reencrypt] region=${region} rows=${rows.length} mode=${apply ? "APPLY" : "dry-run"}`,
);
if (rows.length === 0) {
  await sql.end();
  process.exit(0);
}

let migrated = 0;
let failed = 0;

for (const row of rows) {
  const label = `${row.project_name}/${row.name} (${row.id})`;
  let plaintext: string;
  try {
    plaintext = decryptEnv(
      Buffer.from(row.encrypted_dsn),
      envKey!,
      row.customer_id,
      region,
    );
  } catch (err) {
    failed++;
    console.error(
      `  ✗ ${label}: env-mode decrypt failed — wrong MIDPLANE_KMS_DEV_KEY_${R}? (${(err as Error).message})`,
    );
    continue;
  }

  let ciphertext: Buffer;
  let kmsKeyId: string;
  try {
    const out = await encryptKms(plaintext, cmk!, row.customer_id, region);
    ciphertext = out.ciphertext;
    kmsKeyId = out.kmsKeyId;
    // Verify through the SAME path production reads: KMS Decrypt of the new
    // envelope must reproduce the plaintext byte for byte. Anything less would
    // risk trading an undecryptable row for a differently-undecryptable one.
    const roundTrip = await decryptKms(
      ciphertext,
      kmsKeyId,
      row.customer_id,
      region,
    );
    if (roundTrip !== plaintext) throw new Error("round-trip mismatch");
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}: CMK re-encrypt failed — ${(err as Error).message}`);
    continue;
  }

  if (!apply) {
    console.log(`  · ${label}: would re-encrypt under ${kmsKeyId}`);
    migrated++;
    continue;
  }

  // rotated_at is the operator-visible "this credential's ciphertext changed"
  // timestamp; last_kms_success_at is cleared so the first real decrypt after
  // the migration re-establishes it honestly rather than inheriting a stale
  // witness from the env-mode era.
  await sql`
    update project_databases
    set encrypted_dsn = ${ciphertext},
        kms_key_id = ${kmsKeyId},
        rotated_at = now(),
        last_kms_success_at = null
    where id = ${row.id}
      and kms_key_id = ${`env:${region}`}
  `;
  migrated++;
  console.log(`  ✓ ${label}: re-encrypted under ${kmsKeyId}`);
}

await sql.end();

console.log(
  `[reencrypt] ${apply ? "migrated" : "would migrate"} ${migrated}, failed ${failed}`,
);
if (!apply && migrated > 0) {
  console.log("[reencrypt] re-run with --apply to write");
}
process.exit(failed > 0 ? 1 : 0);
