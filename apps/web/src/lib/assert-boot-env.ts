// Boot-time env validation.
//
// Each downstream module (db, kms, pepper, mcp-proxy) already throws
// fail-fast on its own missing var, but those throws fire lazily — on
// the first request, server action, or admin route that exercises that
// code path. A laptop dev who's missing one var can sit happily on the
// dashboard before tripping the error on a deeper page.
//
// This function collects every required var for the current process
// shape (region pin, KMS mode, hosted vs laptop) and throws ONE error
// listing all the missing ones, so a fresh `.env.local` problem
// surfaces in the first server log line.
//
// Pure presence checks — we deliberately do not validate base64 length
// or hex shape here. The downstream loaders own that and reporting it
// twice would drift. The goal is: "did you remember to set the var?"

interface Issue {
  var: string;
  reason: string;
}

type EnvLike = Record<string, string | undefined>;

export function assertBootEnv(env: EnvLike = process.env): void {
  const issues: Issue[] = [];

  // Region pin
  const region = env.MIDPLANE_REGION;
  if (region !== "eu" && region !== "us") {
    issues.push({
      var: "MIDPLANE_REGION",
      reason: `must be "eu" or "us"; got ${JSON.stringify(region)}`,
    });
  }

  // Per-region requirements. Only checkable if region is valid; otherwise
  // we'd flag a useless mess of derived-var errors.
  if (region === "eu" || region === "us") {
    const upper = region.toUpperCase();

    const dbVar = `DATABASE_URL_${upper}`;
    if (!env[dbVar]) {
      issues.push({ var: dbVar, reason: `required for region '${region}'` });
    }

    const mode = env.MIDPLANE_KMS_MODE ?? "env";
    if (mode === "env") {
      const keyVar = `MIDPLANE_KMS_DEV_KEY_${upper}`;
      if (!env[keyVar]) {
        issues.push({
          var: keyVar,
          reason: `required for env-mode KMS in region '${region}' (run: openssl rand -hex 32)`,
        });
      }
      const pepperVar = `MIDPLANE_TOKEN_PEPPER_${upper}_V1`;
      if (!env[pepperVar]) {
        issues.push({
          var: pepperVar,
          reason: `required for env-mode token pepper in region '${region}' (run: openssl rand -base64 32)`,
        });
      }
    } else if (mode === "kms") {
      const arnVar = `MIDPLANE_KMS_KEY_${upper}`;
      if (!env[arnVar]) {
        issues.push({
          var: arnVar,
          reason: `required for kms-mode in region '${region}' (CMK ARN/alias)`,
        });
      }
      const ctVar = `MIDPLANE_TOKEN_PEPPER_CT_${upper}_V1`;
      if (!env[ctVar]) {
        issues.push({
          var: ctVar,
          reason: `required for kms-mode token pepper in region '${region}' (mint via scripts/encrypt-token-pepper.sh)`,
        });
      }
    } else {
      issues.push({
        var: "MIDPLANE_KMS_MODE",
        reason: `must be 'env' or 'kms'; got ${JSON.stringify(mode)}`,
      });
    }
  }

  // Hosted shape: FLY_API_TOKEN set means the indexer must be reachable.
  // Same check the mcp-proxy makes on first request — surfacing it earlier
  // so a missing INDEXER_TOKEN on a fresh Fly app doesn't wait for the
  // first /mcp/<token> hit to fail.
  if (env.FLY_API_TOKEN && !env.INDEXER_TOKEN) {
    issues.push({
      var: "INDEXER_TOKEN",
      reason: "required when FLY_API_TOKEN is set (hosted audit pipeline)",
    });
  }

  if (issues.length === 0) return;

  const lines = issues.map((i) => `  - ${i.var}: ${i.reason}`);
  throw new Error(
    `Boot-time env validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}\n\nSee .env.example for the full list.`,
  );
}
