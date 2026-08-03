// Boot-time check: can this process's KMS env actually serve the key ids the
// STORED rows carry?
//
// assertKmsLiveness() round-trips a FRESH encrypt under the current mode, so it
// proves the credentials work — but it never touches
// `project_databases.kms_key_id`, and that column is what decryptDsn dispatches
// on. The two can disagree:
//
//   a row written in env-mode carries kms_key_id = 'env:<region>' and stays
//   bound to MIDPLANE_KMS_DEV_KEY_<REGION> forever, even after the region flips
//   to MIDPLANE_KMS_MODE=kms.
//
// Flip the mode, drop the dev key, and every such row becomes undecryptable —
// while the liveness probe still passes green, because a fresh CMK encrypt
// round-trips fine. That happened in EU: three rows stranded on 2026-07-23,
// found on 2026-08-03 only because an agent's queries were failing. Re-encrypt
// stranded rows with `scripts/reencrypt-env-mode-dsns.ts`.
//
// WARNS, DOES NOT THROW — deliberately, and unlike assertKmsLiveness. A failed
// liveness probe means EVERY customer in the region is down, so refusing to boot
// costs nothing. A stranded row means SOME customers are down; refusing to boot
// would take the healthy ones down too, and would block the very deploy that
// ships the fix. So this makes the drift loud and lets the process serve.
//
// Use `scripts/check-kms-key-coverage.ts` as the pre-flight gate BEFORE flipping
// a region's mode — that one exits non-zero.
//
// Note the token pepper has the same data-bound shape and is NOT covered here:
// mcp_tokens.token_hash is a one-way HMAC, so a pepper swap can't be detected by
// inspection, only by tokens silently failing to verify. Re-encrypt the existing
// pepper under the new CMK rather than minting a new one.
//
// nodejs-only (pulls getDb): the caller imports it dynamically behind a
// NEXT_RUNTIME guard so it never enters the Edge bundle.

import { count, eq } from "drizzle-orm";

import { getDb, projectDatabases, projects } from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";

type EnvLike = Record<string, string | undefined>;

export interface KeyCoverageReport {
  /** Distinct stored key ids this env provably cannot decrypt, with row counts.
   *  env-mode rows ONLY — see findStrandedKeyIds. */
  stranded: Array<{ kmsKeyId: string; rows: number; missingEnvVar: string }>;
  /** Distinct CMK arns the boot liveness probe does NOT cover, because it only
   *  round-trips the CONFIGURED CMK. Informational, not a failure. */
  unprobedCmks: Array<{ kmsKeyId: string; rows: number }>;
  /** Distinct stored key ids checked. */
  checked: number;
}

/** Which env var a stored `kms_key_id` needs to be DECRYPTABLE, or null if it
 *  needs none.
 *
 *  Mirrors decryptDsn exactly, and the asymmetry matters: it branches on the
 *  stored id's `env:` prefix, and on the CMK side it passes the STORED arn
 *  straight to `decryptKms` — it never reads MIDPLANE_KMS_KEY_<REGION>. That
 *  var is an ENCRYPT-side input only (encryptDsn picks the CMK to write with).
 *  So a CMK row decrypts on AWS credentials + kms:Decrypt on its own arn, and
 *  treating a missing MIDPLANE_KMS_KEY_<REGION> as "stranded" would be a false
 *  positive on perfectly healthy rows. */
export function requiredEnvVar(
  kmsKeyId: string,
  region: Region,
): string | null {
  return kmsKeyId.startsWith("env:")
    ? `MIDPLANE_KMS_DEV_KEY_${region.toUpperCase()}`
    : null;
}

/** Pure half of the check: which stored key ids can this env provably not
 *  serve? Split out so the dispatch rule is unit-testable without a database —
 *  the DB query is only the row source.
 *
 *  Scope is deliberately narrow: an env-mode row with no dev key is a
 *  STATICALLY provable failure, which is the regression this guards. CMK
 *  reachability is a live IAM/credential question that no env inspection can
 *  answer — see unprobedCmks and the preflight script, which probes for real. */
export function findStrandedKeyIds(
  stored: Array<{ kmsKeyId: string; rows: number }>,
  region: Region,
  env: EnvLike,
): KeyCoverageReport["stranded"] {
  const stranded: KeyCoverageReport["stranded"] = [];
  for (const row of stored) {
    const varName = requiredEnvVar(row.kmsKeyId, region);
    if (varName && !env[varName]) {
      stranded.push({
        kmsKeyId: row.kmsKeyId,
        rows: Number(row.rows),
        missingEnvVar: varName,
      });
    }
  }
  return stranded;
}

/** CMK arns held by rows that the boot liveness probe doesn't exercise.
 *  assertKmsLiveness round-trips MIDPLANE_KMS_KEY_<REGION>; rows written under
 *  a PREVIOUS CMK carry a different arn and need their own kms:Decrypt grant,
 *  which nothing at boot verifies. Reported, never fatal — the grant may well
 *  be in place, and we won't decrypt customer data at boot to find out. */
export function findUnprobedCmks(
  stored: Array<{ kmsKeyId: string; rows: number }>,
  configuredCmk: string | undefined,
): KeyCoverageReport["unprobedCmks"] {
  return stored
    .filter((r) => !r.kmsKeyId.startsWith("env:") && r.kmsKeyId !== configuredCmk)
    .map((r) => ({ kmsKeyId: r.kmsKeyId, rows: Number(r.rows) }));
}

export async function checkKmsKeyCoverage(
  region: Region,
  env: EnvLike = process.env,
): Promise<KeyCoverageReport> {
  // Scoped to the process's own region: the EU app holds no US key material by
  // design (env-var locality), so US rows are not its problem to report.
  const rows = await getDb(region)
    .select({ kmsKeyId: projectDatabases.kmsKeyId, rows: count() })
    .from(projectDatabases)
    .innerJoin(projects, eq(projects.id, projectDatabases.projectId))
    .where(eq(projects.region, region))
    .groupBy(projectDatabases.kmsKeyId);

  return {
    stranded: findStrandedKeyIds(rows, region, env),
    unprobedCmks: findUnprobedCmks(
      rows,
      env[`MIDPLANE_KMS_KEY_${region.toUpperCase()}`],
    ),
    checked: rows.length,
  };
}

/** Boot wrapper: run the check and log the outcome. Never throws — a DB blip at
 *  boot must not take the process down over a diagnostic, and a stranded row
 *  must not block the deploy that fixes it (see header). */
export async function reportKmsKeyCoverage(
  region: Region,
  env: EnvLike = process.env,
): Promise<void> {
  try {
    const { stranded, unprobedCmks, checked } = await checkKmsKeyCoverage(
      region,
      env,
    );
    if (stranded.length === 0) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "kms.key_coverage_ok",
          region,
          distinct_key_ids: checked,
          // Non-fatal: these arns hold rows but aren't the CMK the liveness
          // probe round-trips, so their kms:Decrypt grant is unverified here.
          ...(unprobedCmks.length > 0 ? { unprobed_cmks: unprobedCmks } : {}),
          ts: new Date().toISOString(),
        }),
      );
      return;
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "kms.key_coverage_stranded",
        region,
        stranded,
        affected_rows: stranded.reduce((n, s) => n + s.rows, 0),
        remedy:
          "these project_databases rows cannot be decrypted with this process's env — " +
          "re-encrypt with scripts/reencrypt-env-mode-dsns.ts, or restore the missing key",
        ts: new Date().toISOString(),
      }),
    );
    // Route to the error tracker too: the console line above is only read when
    // someone is already looking, which is exactly what failed last time.
    const { captureError } = await import("./analytics.ts");
    captureError(
      "kms.key_coverage_stranded",
      new Error(
        `${stranded.length} stored KMS key id(s) unserveable in region '${region}': ` +
          stranded
            .map((s) => `${s.kmsKeyId} (${s.rows} rows, needs ${s.missingEnvVar})`)
            .join("; "),
      ),
      { properties: { region } },
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "kms.key_coverage_check_failed",
        region,
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
  }
}
