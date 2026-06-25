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
// Mostly presence checks — we deliberately do not validate base64 length
// or hex shape for the crypto material (peppers, KMS keys): the downstream
// loaders own that and reporting it twice would drift. The lone exception is
// the session / region-cookie SIGNING secrets, which get a length floor (see
// secretIssue) because nothing downstream length-checks them and a too-short
// value is a silent security footgun. Otherwise the goal is just: "did you
// remember to set the var?"

import { SELF_HOST_REGION } from "./self-host.ts";

interface Issue {
  var: string;
  reason: string;
}

type EnvLike = Record<string, string | undefined>;

export function assertBootEnv(env: EnvLike = process.env): void {
  // Self-host is a different process shape: one DATABASE_URL (no per-region
  // DATABASE_URL_<R>), no MIDPLANE_REGION (bootRegion pins it), no region
  // cookie, no Fly/indexer plumbing. Crypto reuses env-mode against the pinned
  // region's keys. Validate that surface and skip the cloud checks entirely.
  // Read the flag off the passed env (not isSelfHost()'s process.env) so the
  // function validates one consistent snapshot — at boot the two are identical.
  if (env.MIDPLANE_SELF_HOST === "1") {
    throwIfIssues(selfHostIssues(env));
    return;
  }

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

  // --- MCP OAuth issuer (P6) ---
  // The Better Auth `mcp` plugin builds its OAuth 2.1 discovery metadata
  // (issuer + authorize/token endpoints) from BETTER_AUTH_URL. It must be a
  // concrete origin or the discovery + agent OAuth flow fail at request time.
  if (!env.BETTER_AUTH_URL) {
    issues.push({
      var: "BETTER_AUTH_URL",
      reason:
        "required as the OAuth issuer for MCP discovery (this app's origin, e.g. https://eu.app.midplane.ai)",
    });
  }

  // Session + region-cookie signing secrets. Length-floored, not presence-only
  // (see secretIssue): a missing BETTER_AUTH_SECRET makes Better Auth fall back
  // to an insecure built-in default, and the region cookie HMAC must match
  // across the apex + both regional web apps. REGION_COOKIE_SECRET is cloud-only
  // — self-host short-circuits all region routing (middleware.ts), so it lives
  // here and NOT in selfHostIssues().
  pushIssue(
    issues,
    secretIssue(
      env,
      "BETTER_AUTH_SECRET",
      "signs sessions; Better Auth uses an insecure built-in default if unset",
    ),
  );
  pushIssue(
    issues,
    secretIssue(
      env,
      "MIDPLANE_REGION_COOKIE_SECRET",
      "HMAC for the signed region cookie; must match across apex + both web apps",
    ),
  );
  pushIssue(issues, maskSaltIssue(env));

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

  // Stripe billing (cloud-only). All-or-nothing: zero Stripe vars = billing is
  // off and the app boots fine (keyless dev — /billing degrades to "talk to
  // us"). But a PARTIAL config is a deploy footgun — Checkout/Portal/webhook
  // would 500 on first use — so if ANY Stripe var is set, require ALL four.
  // Deliberately NOT in the self-host branch: self-host never bills.
  issues.push(...stripeIssues(env));

  throwIfIssues(issues);
}

// Signing secrets we length-floor rather than presence-check (the one
// deliberate exception to this file's "presence only" rule — see the header).
// An empty or trivially short value is a silent security footgun: Better Auth
// falls back to a built-in DEFAULT secret when BETTER_AUTH_SECRET is unset, so
// it would sign real sessions with publicly-known key material rather than
// failing. No downstream loader length-checks these, so boot is the only place
// to catch it. 32 chars is the documented floor (openssl rand -base64 32 → 44).
const MIN_SECRET_LEN = 32;

function secretIssue(
  env: EnvLike,
  varName: string,
  purpose: string,
): Issue | null {
  const v = env[varName];
  if (!v) {
    return {
      var: varName,
      reason: `required (${purpose}); 32+ bytes — run: openssl rand -base64 32`,
    };
  }
  if (v.length < MIN_SECRET_LEN) {
    return {
      var: varName,
      reason: `too short (${v.length} chars) — ${purpose}; needs 32+ bytes (openssl rand -base64 32)`,
    };
  }
  return null;
}

function pushIssue(issues: Issue[], issue: Issue | null): void {
  if (issue) issues.push(issue);
}

// Masking salt master — validate-if-SET only. Masking is opt-in (a deploy with
// no masked columns needs no salt), so an UNSET master is NOT a boot error: the
// hard "a project declares column_masks but the salt is unset" gate is fail-
// closed at spawn time (proxy / preview / engine), and the mask-config UI now
// surfaces it at save time. But a SET-but-weak master is a silent footgun — the
// deterministic transforms (consistent-hash, pseudonymize) become correlatable —
// so length-floor it when present, same posture as the signing secrets above.
// Applies to both cloud and self-host (both spawn engines with masks).
function maskSaltIssue(env: EnvLike): Issue | null {
  const v = env.MIDPLANE_MASK_SALT_MASTER;
  if (!v) return null;
  if (v.length < MIN_SECRET_LEN) {
    return {
      var: "MIDPLANE_MASK_SALT_MASTER",
      reason: `too short (${v.length} chars) — keys deterministic masking transforms; needs 32+ bytes (openssl rand -hex 32)`,
    };
  }
  return null;
}

// Cloud Stripe vars, validated all-or-nothing (see call site). Returns issues
// only when the config is partial; zero set = billing off = no issues.
function stripeIssues(env: EnvLike): Issue[] {
  const vars = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_PRICE_ID",
    "STRIPE_TEAM_PRICE_ID",
  ] as const;
  const setCount = vars.filter((v) => env[v]).length;
  if (setCount === 0 || setCount === vars.length) return [];
  return vars
    .filter((v) => !env[v])
    .map((v) => ({
      var: v,
      reason:
        "required once any Stripe var is set (billing is all-or-nothing; see scripts/stripe-setup.ts)",
    }));
}

// Self-host required vars. One DB, no region pin, env-mode crypto against the
// region self-host pins to (SELF_HOST_REGION). The _<REGION> suffix on the
// crypto vars is an internal artifact of that pin — documented in the SELFHOST
// block of .env.example.
function selfHostIssues(env: EnvLike): Issue[] {
  const issues: Issue[] = [];

  if (!env.DATABASE_URL) {
    issues.push({
      var: "DATABASE_URL",
      reason: "required in self-host (single Postgres; getDb ignores region)",
    });
  }

  // MCP OAuth issuer (P6): same requirement as cloud — the `mcp` plugin's
  // discovery metadata needs a concrete origin for the self-host instance.
  if (!env.BETTER_AUTH_URL) {
    issues.push({
      var: "BETTER_AUTH_URL",
      reason:
        "required as the OAuth issuer for MCP discovery (this instance's origin)",
    });
  }

  // Sessions are signed in self-host too — same Better Auth default-secret
  // footgun as cloud. (No MIDPLANE_REGION_COOKIE_SECRET: self-host skips region
  // routing entirely.)
  pushIssue(
    issues,
    secretIssue(
      env,
      "BETTER_AUTH_SECRET",
      "signs sessions; Better Auth uses an insecure built-in default if unset",
    ),
  );
  pushIssue(issues, maskSaltIssue(env));

  const upper = SELF_HOST_REGION.toUpperCase();
  const mode = env.MIDPLANE_KMS_MODE ?? "env";
  if (mode === "env") {
    const keyVar = `MIDPLANE_KMS_DEV_KEY_${upper}`;
    if (!env[keyVar]) {
      issues.push({
        var: keyVar,
        reason: `required for env-mode credential encryption (self-host pins region '${SELF_HOST_REGION}'; run: openssl rand -hex 32)`,
      });
    }
    const pepperVar = `MIDPLANE_TOKEN_PEPPER_${upper}_V1`;
    if (!env[pepperVar]) {
      issues.push({
        var: pepperVar,
        reason: `required for env-mode token pepper (self-host; run: openssl rand -base64 32)`,
      });
    }
  } else {
    issues.push({
      var: "MIDPLANE_KMS_MODE",
      reason: `self-host supports only env-mode KMS; got ${JSON.stringify(mode)} (no AWS in self-host)`,
    });
  }

  return issues;
}

function throwIfIssues(issues: Issue[]): void {
  if (issues.length === 0) return;

  const lines = issues.map((i) => `  - ${i.var}: ${i.reason}`);
  throw new Error(
    `Boot-time env validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}\n\nSee .env.example for the full list.`,
  );
}
