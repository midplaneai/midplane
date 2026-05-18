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

/** Strict-mode tenant_scope config — mirrors OSS 0.5.0's parser.
 *  Resolution per queried table at engine time: exempt → overrides → column.
 *
 *  - `column` is the universal default tenant column. When set, every
 *    queried table is scoped on it unless overridden or exempted.
 *    `null` means only the listed `overrides` are checked; every other
 *    queried table is unscoped. Cloud keeps writing this shape for
 *    customers who haven't set a default column yet (e.g. configs
 *    backfilled from a pre-0.5.0 flat map).
 *  - `overrides` are per-table column overrides (renamed from `mappings`
 *    in 0.4.x; OSS accepts `mappings:` as a deprecated alias on parse).
 *  - `exempt` is the list of tables intentionally tenant-free (audit_log,
 *    regions, …) — required to query an unscoped table under strict
 *    mode. `information_schema` is exempt engine-side regardless.
 *
 *  Inert config (`column: null`, `overrides: {}`) means tenant_scope is
 *  disabled for the DB; the YAML omits the block entirely. */
export interface TenantScopeConfig {
  column: string | null;
  overrides: Record<string, string>;
  exempt: string[];
}

/** Zero-value config — column unset, no overrides, no exempts. Cloud
 *  uses this as the default for new connection_databases rows. */
export const EMPTY_TENANT_SCOPE: TenantScopeConfig = {
  column: null,
  overrides: {},
  exempt: [],
};

/** True iff the config will actually enforce a predicate on at least one
 *  table. exempt-only configs are inert (per OSS 0.5.0 wire shape:
 *  `tenant_scope_enabled = column !== null OR overrides non-empty`). */
export function tenantScopeIsActive(config: TenantScopeConfig): boolean {
  return config.column !== null || Object.keys(config.overrides).length > 0;
}

export interface DatabaseEntry {
  name: string;
  /** Connection-database id used to derive the DSN env var name. ULIDs
   *  match OSS-side `[A-Z_][A-Z0-9_]*` so dsnEnvVarFor never produces an
   *  invalid var name. */
  connectionDatabaseId: string;
  tableAccess: TableAccessPolicy;
  /** Strict-mode tenant_scope envelope. EMPTY_TENANT_SCOPE = disabled
   *  for this DB; the YAML omits the block entirely (OSS treats absent
   *  block as disabled). */
  tenantScope: TenantScopeConfig;
}

// Mirrors OSS ENV_INTERP_RE so the cloud refuses to derive an env var name
// that the engine's `${VAR}` substitution wouldn't match. A raw UUID
// (lowercase letters + hyphens) would slip past the spawner's run command
// just to fail at engine boot — fail loud here instead.
const OSS_ENV_INTERP_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Env var name the spawner injects this DB's plaintext DSN under, and
 *  that the YAML `url:` field references via ${...} interpolation. The
 *  full name (prefix + id) must match OSS ENV_INTERP_RE
 *  `[A-Z_][A-Z0-9_]*` — ULIDs (uppercase Crockford base32) and uppercase
 *  hex IDs both qualify; raw UUIDs (lowercase + hyphens) do NOT. Throws
 *  rather than silently mis-substituting, since OSS would treat an
 *  unmatched `${...}` as a literal url and refuse the connection. */
export function dsnEnvVarFor(connectionDatabaseId: string): string {
  const name = `MIDPLANE_DSN_${connectionDatabaseId}`;
  if (!OSS_ENV_INTERP_NAME_RE.test(name)) {
    throw new Error(
      `dsnEnvVarFor: connection_database id "${connectionDatabaseId}" produces env var name "${name}" that does not match OSS env-interpolation regex [A-Z_][A-Z0-9_]* (lowercase letters, hyphens, or other punctuation are not allowed)`,
    );
  }
  return name;
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
    emitTenantScope(lines, db.tenantScope);
  }
  return lines.join("\n") + "\n";
}

// Two identifier shapes drive tenant_scope validation:
//
//   IDENT_RE          Column name. Single Postgres unquoted identifier.
//                     Used for `column` (default tenant column) and the
//                     VALUES of `overrides` (per-table tenant column).
//
//   TABLE_IDENT_RE    Table name. Same shape as TABLE_NAME_RE used by
//                     table_access — allows an optional `schema.` prefix
//                     so a value picked from the introspection
//                     autocomplete (e.g. "public.users") round-trips.
//                     Used for `overrides` KEYS and `exempt` entries.
//
// Splitting these mirrors the engine's own resolution: `overrides` is a
// table-keyed map whose values are column names, not table names.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const MAX_TENANT_SCOPE_ENTRIES = 256;
const MAX_TENANT_SCOPE_IDENT_LENGTH = 128;

export interface TenantScopeValidationError {
  path: string;
  message: string;
}
export type TenantScopeValidationResult =
  | { ok: true; value: TenantScopeConfig }
  | { ok: false; errors: TenantScopeValidationError[] };

// Validate untrusted input into a typed TenantScopeConfig. Mirrors the
// shape OSS 0.5.0's parser accepts: `column` is a single identifier or
// null; `overrides` is a Record<table, column> with identifier keys and
// values; `exempt` is a list of identifier-shaped table names. Wraps a
// legacy 0.4.x flat map ({orders: "tenant_id"}) as `overrides` so a
// JSONB row read from a pre-migration DB normalizes to the new shape.
export function validateTenantScope(
  input: unknown,
): TenantScopeValidationResult {
  const errors: TenantScopeValidationError[] = [];
  if (input == null) return { ok: true, value: EMPTY_TENANT_SCOPE };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "", message: "tenant_scope must be an object" }],
    };
  }
  const obj = input as Record<string, unknown>;

  // Legacy 0.4.x shape: a flat map of table → column with no envelope.
  // Detect by absence of any of the three envelope keys and presence of
  // at least one value-typed entry. Wrap as overrides; column stays
  // null so engine behavior matches today.
  const looksLegacy =
    !("column" in obj) && !("overrides" in obj) && !("exempt" in obj);
  const rawOverrides = looksLegacy ? obj : obj.overrides;
  const rawColumn = looksLegacy ? null : obj.column;
  const rawExempt = looksLegacy ? [] : obj.exempt;

  let column: string | null = null;
  if (rawColumn === null || rawColumn === undefined) {
    column = null;
  } else if (typeof rawColumn !== "string") {
    errors.push({ path: "column", message: "must be a string or null" });
  } else if (!isIdent(rawColumn)) {
    errors.push({ path: "column", message: identMessage });
  } else {
    column = rawColumn;
  }

  const overrides: Record<string, string> = {};
  if (rawOverrides === undefined || rawOverrides === null) {
    // empty
  } else if (typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
    errors.push({ path: "overrides", message: "must be an object" });
  } else {
    const entries = Object.entries(rawOverrides as Record<string, unknown>);
    if (entries.length > MAX_TENANT_SCOPE_ENTRIES) {
      errors.push({
        path: "overrides",
        message: `too many entries (max ${MAX_TENANT_SCOPE_ENTRIES})`,
      });
    }
    for (const [k, v] of entries) {
      if (!isTableIdent(k)) {
        errors.push({ path: `overrides.${k}`, message: tableIdentMessage });
        continue;
      }
      if (typeof v !== "string" || !isIdent(v)) {
        errors.push({
          path: `overrides.${k}`,
          message: `value ${identMessage}`,
        });
        continue;
      }
      overrides[k] = v;
    }
  }

  const exempt: string[] = [];
  if (rawExempt === undefined || rawExempt === null) {
    // empty
  } else if (!Array.isArray(rawExempt)) {
    errors.push({ path: "exempt", message: "must be an array" });
  } else {
    if (rawExempt.length > MAX_TENANT_SCOPE_ENTRIES) {
      errors.push({
        path: "exempt",
        message: `too many entries (max ${MAX_TENANT_SCOPE_ENTRIES})`,
      });
    }
    const seen = new Set<string>();
    for (const t of rawExempt) {
      if (typeof t !== "string" || !isTableIdent(t)) {
        errors.push({
          path: `exempt[${exempt.length}]`,
          message: tableIdentMessage,
        });
        continue;
      }
      if (seen.has(t)) continue;
      seen.add(t);
      exempt.push(t);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { column, overrides, exempt } };
}

/** Strict variant for code paths that must not see invalid config. The
 *  spawner / hot-reload paths use this — a malformed row in Postgres
 *  should fail closed rather than start an OSS container with degraded
 *  scoping. */
export function parseTenantScopeOrThrow(input: unknown): TenantScopeConfig {
  const r = validateTenantScope(input);
  if (r.ok) return r.value;
  const summary = r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
  throw new Error(`invalid tenant_scope: ${summary}`);
}

function isIdent(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= MAX_TENANT_SCOPE_IDENT_LENGTH &&
    IDENT_RE.test(s)
  );
}
function isTableIdent(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= MAX_TENANT_SCOPE_IDENT_LENGTH &&
    TABLE_IDENT_RE.test(s)
  );
}
const identMessage = `must match ${IDENT_RE} (Postgres unquoted identifier)`;
const tableIdentMessage = `must match ${TABLE_IDENT_RE} (Postgres unquoted identifier, optionally schema-qualified)`;

// Emit the OSS 0.5.0 tenant_scope envelope. Inert configs (no column,
// no overrides) skip emission entirely so the resulting YAML reads like
// a pre-tenant-scope DB. Everything dynamic is validated cloud-side
// before this fires; the IDENT_RE checks below are defense-in-depth for
// any direct caller of the serializer that bypassed the form.
//
// information_schema is engine-side exempt regardless of what we emit
// (per OSS 0.5.0 release notes), so list_tables / describe_table keep
// working under strict mode without an explicit entry here.
function emitTenantScope(
  lines: string[],
  config: TenantScopeConfig,
): void {
  // Exempt-only configs (no column, no overrides) are inert — exempting
  // tables that aren't scoped is a no-op. Skip emission so the YAML
  // reads identically to a true disabled config and we don't ship
  // bytes the engine will treat as disabled anyway.
  if (!tenantScopeIsActive(config)) {
    return;
  }
  lines.push(`    tenant_scope:`);
  lines.push(`      enabled: true`);
  if (config.column !== null) {
    if (!IDENT_RE.test(config.column)) {
      throw new Error(
        `serializeMultiDbPolicyToYaml: tenant_scope.column "${config.column}" contains characters that need YAML quoting`,
      );
    }
    lines.push(`      column: ${config.column}`);
  }
  const overrides = Object.entries(config.overrides).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (overrides.length > 0) {
    for (const [k, v] of overrides) {
      if (!TABLE_IDENT_RE.test(k) || !IDENT_RE.test(v)) {
        throw new Error(
          `serializeMultiDbPolicyToYaml: tenant_scope.overrides ${k} -> ${v} contains characters that need YAML quoting`,
        );
      }
    }
    lines.push(`      overrides:`);
    for (const [k, v] of overrides) {
      lines.push(`        ${k}: ${v}`);
    }
  }
  const exempt = [...config.exempt].sort();
  if (exempt.length > 0) {
    for (const t of exempt) {
      if (!TABLE_IDENT_RE.test(t)) {
        throw new Error(
          `serializeMultiDbPolicyToYaml: tenant_scope.exempt "${t}" contains characters that need YAML quoting`,
        );
      }
    }
    lines.push(`      exempt:`);
    for (const t of exempt) {
      lines.push(`        - ${t}`);
    }
  }
}

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
