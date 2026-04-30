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

// Serialize to the YAML shape the OSS engine reads. We hand-roll because
// the schema is flat and predictable; pulling in js-yaml would add ~30KB
// for two top-level keys.
//
//   default: read
//   tables:
//     public.users: read
//     orders: deny
//
// Table names are validated to TABLE_NAME_RE so they never need YAML
// quoting; access levels are a fixed enum, also unquoted-safe.
export function serializePolicyToYaml(policy: TableAccessPolicy): string {
  const lines: string[] = [];
  lines.push(`default: ${policy.default}`);
  const entries = Object.entries(policy.tables).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) {
    lines.push("tables: {}");
  } else {
    lines.push("tables:");
    for (const [name, level] of entries) {
      lines.push(`  ${name}: ${level}`);
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
