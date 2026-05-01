// table_access policy — Cloud-native shape that mirrors the OSS engine's
// `table_access` YAML 1:1. JSONB at rest in `connections.table_access`,
// serialized to YAML at container spawn time and mounted at the path the
// engine reads via MIDPLANE_POLICY_FILE.
//
// Both the dashboard server actions (on save) and the spawner (on
// serialize) run the same validator. Reject at save time, never at spawn
// time — a bad policy in Postgres would brick the customer's container.

export const ACCESS_LEVELS = ["deny", "read", "read_write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface TableAccessPolicy {
  default: AccessLevel;
  tables: Record<string, AccessLevel>;
}

// Identifier-like; allows schema-qualified names (`public.users`) and
// $-suffixed Postgres conventions. No quoting, no spaces, no wildcards —
// the engine's lookup is exact-match on the parsed table name. Open
// question in the design doc whether the engine will ever surface
// quoted/case-sensitive names; if so, this regex widens.
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const MAX_TABLE_NAME_LENGTH = 128;
const MAX_TABLES_PER_POLICY = 1000;

export const DEFAULT_POLICY: TableAccessPolicy = {
  default: "deny",
  tables: {},
};

export interface PolicyValidationError {
  path: string;
  message: string;
}

export type PolicyValidationResult =
  | { ok: true; value: TableAccessPolicy }
  | { ok: false; errors: PolicyValidationError[] };

// Validate untrusted input (form data, JSONB row read) into a typed
// policy. Returns structured errors so the dashboard form can surface
// them per-field; the spawner just refuses to start if validation fails.
export function validatePolicy(input: unknown): PolicyValidationResult {
  const errors: PolicyValidationError[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "", message: "policy must be an object" }],
    };
  }
  const obj = input as Record<string, unknown>;

  const def = obj.default;
  if (!isAccessLevel(def)) {
    errors.push({
      path: "default",
      message: `must be one of ${ACCESS_LEVELS.join(", ")}`,
    });
  }

  const tables = obj.tables;
  const validatedTables: Record<string, AccessLevel> = {};
  if (tables === undefined || tables === null) {
    // Treat as empty.
  } else if (typeof tables !== "object" || Array.isArray(tables)) {
    errors.push({ path: "tables", message: "must be an object" });
  } else {
    const entries = Object.entries(tables as Record<string, unknown>);
    if (entries.length > MAX_TABLES_PER_POLICY) {
      errors.push({
        path: "tables",
        message: `too many entries (max ${MAX_TABLES_PER_POLICY})`,
      });
    }
    const seen = new Set<string>();
    for (const [name, level] of entries) {
      if (name.length === 0 || name.length > MAX_TABLE_NAME_LENGTH) {
        errors.push({
          path: `tables.${name}`,
          message: `name length must be 1–${MAX_TABLE_NAME_LENGTH} chars`,
        });
        continue;
      }
      if (!TABLE_NAME_RE.test(name)) {
        errors.push({
          path: `tables.${name}`,
          message: "name must match [A-Za-z_][A-Za-z0-9_$]* with optional schema prefix",
        });
        continue;
      }
      if (seen.has(name)) {
        errors.push({ path: `tables.${name}`, message: "duplicate" });
        continue;
      }
      seen.add(name);
      if (!isAccessLevel(level)) {
        errors.push({
          path: `tables.${name}`,
          message: `must be one of ${ACCESS_LEVELS.join(", ")}`,
        });
        continue;
      }
      validatedTables[name] = level;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { default: def as AccessLevel, tables: validatedTables },
  };
}

// Strict variant for code paths that must not see invalid policy data.
// The spawner uses this — if Postgres ever holds a malformed row, fail
// closed instead of starting an OSS container with a degraded policy.
export function parsePolicyOrThrow(input: unknown): TableAccessPolicy {
  const r = validatePolicy(input);
  if (r.ok) return r.value;
  const summary = r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
  throw new Error(`invalid table_access policy: ${summary}`);
}

// --- DB name validation -----------------------------------------------------
//
// Mirrors OSS-side DB_NAME_RE so a name validated cloud-side also passes
// the engine's parsePolicyYaml. Reserved name `__default__` is the OSS
// internal sentinel for the legacy single-DB shape; operators may not use
// it for a real DB.

export const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const RESERVED_DB_NAMES = ["__default__"] as const;

export function isValidDbName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    DB_NAME_RE.test(name) &&
    !(RESERVED_DB_NAMES as readonly string[]).includes(name)
  );
}

// --- YAML serialization -----------------------------------------------------
//
// The cloud always emits the multi-DB `databases:` shape, even for N=1.
// OSS 0.2.0 treats a one-entry `databases:` array identically to legacy
// DATABASE_URL, but emitting uniform YAML keeps the spawn path single-
// branched and makes inspection of /etc/midplane/policy.yaml predictable.
//
// DSNs are NEVER inlined into the YAML — they're injected as env vars
// (`MIDPLANE_DSN_<connectionDatabaseId>`) and referenced from `url:` via
// the OSS env-interpolation regex `${VAR}`. This preserves the trust
// posture from packages/router/src/spawner.ts:13: "DSN is NEVER logged or
// persisted; it lives in the container's env, not on disk."
//
// Hand-rolled serializer (vs. js-yaml) keeps the dep footprint tiny. All
// dynamic values are validated upstream (DB names match DB_NAME_RE, table
// names match TABLE_NAME_RE, access levels are a closed enum, env-var
// names are derived from ULID-shaped ids) so none need YAML quoting.

export interface DatabaseEntry {
  name: string;
  /** Connection-database id used to derive the DSN env var name. ULIDs
   *  match OSS-side `[A-Z_][A-Z0-9_]*` so dsnEnvVarFor never produces an
   *  invalid var name. */
  connectionDatabaseId: string;
  tableAccess: TableAccessPolicy;
  /** Empty map = tenant_scope disabled for this DB; the YAML omits the
   *  block entirely (OSS treats absent block as disabled). */
  tenantScopeMappings: Record<string, string>;
}

/** Env var name the spawner injects this DB's plaintext DSN under, and
 *  that the YAML `url:` field references via ${...} interpolation. ULIDs
 *  are uppercase Crockford base32; "MIDPLANE_DSN_" is uppercase ASCII —
 *  the resulting name matches OSS ENV_INTERP_RE `[A-Z_][A-Z0-9_]*`. */
export function dsnEnvVarFor(connectionDatabaseId: string): string {
  return `MIDPLANE_DSN_${connectionDatabaseId}`;
}

export function serializeMultiDbPolicyToYaml(
  databases: readonly DatabaseEntry[],
): string {
  if (databases.length === 0) {
    throw new Error("serializeMultiDbPolicyToYaml: at least one database required");
  }
  const seen = new Set<string>();
  for (const db of databases) {
    if (!isValidDbName(db.name)) {
      throw new Error(
        `serializeMultiDbPolicyToYaml: invalid database name "${db.name}" (must match ${DB_NAME_RE} and not be reserved)`,
      );
    }
    if (seen.has(db.name)) {
      throw new Error(
        `serializeMultiDbPolicyToYaml: duplicate database name "${db.name}"`,
      );
    }
    seen.add(db.name);
  }

  const lines: string[] = ["databases:"];
  for (const db of databases) {
    lines.push(`  - name: ${db.name}`);
    lines.push(`    url: \${${dsnEnvVarFor(db.connectionDatabaseId)}}`);
    lines.push(`    table_access:`);
    lines.push(`      default: ${db.tableAccess.default}`);
    const tables = Object.entries(db.tableAccess.tables).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (tables.length === 0) {
      lines.push(`      tables: {}`);
    } else {
      lines.push(`      tables:`);
      for (const [name, level] of tables) {
        lines.push(`        ${name}: ${level}`);
      }
    }
    const mappings = Object.entries(db.tenantScopeMappings).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (mappings.length > 0) {
      // Validate keys/values are simple identifiers (no quoting needed).
      // Mappings come from the policy form which is gated; this is a
      // defense-in-depth check before YAML emission.
      for (const [k, v] of mappings) {
        if (!IDENT_RE.test(k) || !IDENT_RE.test(v)) {
          throw new Error(
            `serializeMultiDbPolicyToYaml: tenant_scope mapping ${k} -> ${v} contains characters that need YAML quoting`,
          );
        }
      }
      lines.push(`    tenant_scope:`);
      lines.push(`      enabled: true`);
      lines.push(`      mappings:`);
      for (const [k, v] of mappings) {
        lines.push(`        ${k}: ${v}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Tenant-scope key/value identifier shape. Postgres column-name pattern;
// no quoting required for unquoted YAML emission.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- Legacy single-DB serializer (admin hot-reload) -------------------------
//
// Used only by the admin /admin/policy hot-reload path (packages/router/
// src/admin.ts), which sends a single-DB policy body to a running engine.
// Spawn-time YAML emission goes through serializeMultiDbPolicyToYaml above;
// once the multi-DB hot-reload story lands (PR-B / PR-C), this can collapse
// into a single emitter that wraps either shape.
//
// The `table_access:` wrapper is required — OSS PolicyFileSchema reads
// `table_access.default` and `table_access.tables` as the legacy shape.
// Table names pass TABLE_NAME_RE so they never need YAML quoting.
export function serializePolicyToYaml(policy: TableAccessPolicy): string {
  const lines: string[] = ["table_access:"];
  lines.push(`  default: ${policy.default}`);
  const entries = Object.entries(policy.tables).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) {
    lines.push("  tables: {}");
  } else {
    lines.push("  tables:");
    for (const [name, level] of entries) {
      lines.push(`    ${name}: ${level}`);
    }
  }
  return lines.join("\n") + "\n";
}

function isAccessLevel(v: unknown): v is AccessLevel {
  return (
    typeof v === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(v)
  );
}
