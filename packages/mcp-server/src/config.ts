// Env-var → typed Config. Schema-validated via zod; refuse to boot on invalid.
//
// Honored: DATABASE_URL, PORT, DB_PATH, MIDPLANE_TENANT_ID,
// MIDPLANE_POLICY_FILE, MIDPLANE_TRANSPORT, INDEXER_TOKEN.
//
// loadPolicyFile reads + parses a YAML override file. The MCP server
// consumes the tenant_scope mappings and the table_access config; the
// four policy rules are hardcoded.
//
// 0.2.0: the YAML may instead carry a top-level `databases:` array — one
// entry per Postgres DB. Each entry has its own `url`, `table_access`, and
// `tenant_scope`. When `databases:` is present the top-level
// table_access / tenant_scope and env DATABASE_URL are ignored (warn at
// boot if both are set). Single-DB users are unaffected; they keep the
// legacy shape and see an identical MCP tool surface.

import { z } from "zod";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export const TransportSchema = z.enum(["stdio", "http"]);
export type Transport = z.infer<typeof TransportSchema>;

export const ConfigSchema = z.object({
  // Optional in 0.2.0: a YAML `databases:` block can supply the DSN(s).
  // The loader (loadConfig) checks below that at least one of
  // DATABASE_URL or `databases:` is present at boot.
  databaseUrl: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  dbPath: z.string().default("/data/audit.db"),
  tenantId: z.string().default("__self_host__"),
  policyFile: z.string().optional(),
  transport: TransportSchema.default("http"),
  // Bearer token for the cloud indexer's pull endpoints. Unset → routes 404.
  indexerToken: z.string().min(1).optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

const TableAccessLevelSchema = z.enum(["deny", "read", "read_write"]);

// tenant_scope YAML shape (0.5.0).
//
// Strict semantics: when `column` is set, every queried table is scoped on
// that column UNLESS it's listed in `exempt` or has a different column in
// `overrides`. When `column` is unset, the legacy "only `overrides` listed
// tables get checked" behavior applies (pre-0.5.0 `mappings` semantics).
//
// `mappings` is the pre-0.5.0 alias for `overrides`. Both reading and
// hot-swapping accept it; setting both `mappings` and `overrides` in one
// document is rejected (see resolveTenantScope).
const TenantScopeSchema = z.object({
  enabled: z.boolean().default(true),
  column: z.string().min(1).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
  exempt: z.array(z.string().min(1)).optional(),
  mappings: z.record(z.string(), z.string()).optional(),
});

const TableAccessSchema = z.object({
  default: TableAccessLevelSchema.default("read"),
  tables: z.record(z.string(), TableAccessLevelSchema).default({}),
});

// Per-DB entry in `databases:`. Schema validation only — name regex,
// reserved-name, dup-detect, and env interpolation are applied by the
// loader after zod parses.
const DatabaseEntrySchema = z.object({
  name: z.string().min(1).max(32),
  url: z.string().min(1),
  tenant_scope: TenantScopeSchema.optional(),
  table_access: TableAccessSchema.optional(),
});

const PolicyFileSchema = z.object({
  // Legacy single-DB shape (still the documented common case).
  tenant_scope: TenantScopeSchema.optional(),
  table_access: TableAccessSchema.optional(),
  // Multi-DB shape (0.2.0+). Mutually exclusive with the legacy shape at
  // resolve time; if both are present the legacy fields are ignored and a
  // warning is emitted.
  databases: z.array(DatabaseEntrySchema).optional(),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export type TableAccessLevel = z.infer<typeof TableAccessLevelSchema>;

// Resolved tenant_scope config the engine evaluates against. Always
// well-formed; loader/resolver normalize every accepted YAML shape into
// this single structure. An `enabled: false` document, an empty document,
// or a doc with `defaultColumn: null` + no overrides all collapse to the
// inert config (no enforcement).
export interface TenantScopeSpec {
  defaultColumn: string | null;
  overrides: Record<string, string>;
  exempt: string[];
}

// One resolved DB. The loader produces N>=1 of these from a YAML doc:
// either one synthetic `__default__` (legacy shape) or one per `databases:`
// entry. Downstream construction (engine registry) treats both uniformly.
export interface DatabaseSpec {
  name: string;
  url: string;
  tenantScope: TenantScopeSpec;
  hasTenantScope: boolean;
  tableAccess: {
    default: TableAccessLevel;
    tables: Record<string, TableAccessLevel>;
  } | null;
  hasTableAccess: boolean;
}

export const EMPTY_TENANT_SCOPE: TenantScopeSpec = {
  defaultColumn: null,
  overrides: {},
  exempt: [],
};

// Reserved name for the synthetic single-DB entry. Operators may not use
// this in `databases[].name`.
export const DEFAULT_DB_NAME = "__default__";
const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_INTERP_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export interface LoadedPolicy {
  // Resolved per-DB list. Always at least one entry. For the legacy single-
  // DB path the entry is named DEFAULT_DB_NAME and its url is "" (the boot
  // path fills it from env DATABASE_URL via resolveDatabasesFromConfig).
  databases: DatabaseSpec[];
  // True iff the source document explicitly contained a `databases:` array
  // (vs. the legacy single-DB shape). Loaders use this to know how to merge
  // env DATABASE_URL.
  hasDatabasesBlock: boolean;

  // ── Legacy-shape mirrors ───────────────────────────────────────────────
  // For the single-DB legacy path these mirror databases[0].* so callers
  // that pre-date 0.2.0 keep reading `policy.tenantScope` etc. unchanged.
  // For the multi-DB shape these are the empty/null defaults.
  //
  // hasTenantScope / hasTableAccess preserve the omit-vs-empty distinction
  // for the legacy hot-reload endpoint path.
  tenantScope: TenantScopeSpec;
  tableAccess: {
    default: TableAccessLevel;
    tables: Record<string, TableAccessLevel>;
  } | null;
  hasTenantScope: boolean;
  hasTableAccess: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // Boot-time precondition: at least one DSN source MUST be configured. Env
  // DATABASE_URL is the legacy single-DB path; MIDPLANE_POLICY_FILE may
  // alternatively carry a `databases:` block whose entries supply the DSN(s).
  // Without either we'd boot a server with nothing to connect to.
  if (
    (!env.DATABASE_URL || env.DATABASE_URL.length === 0) &&
    (!env.MIDPLANE_POLICY_FILE || env.MIDPLANE_POLICY_FILE.length === 0)
  ) {
    throw new Error(
      "Configuration error: DATABASE_URL is required. " +
        "Set it to a Postgres DSN (e.g. postgres://user:pass@host:5432/db), " +
        "or supply MIDPLANE_POLICY_FILE with a `databases:` block.",
    );
  }

  const raw = {
    databaseUrl: env.DATABASE_URL,
    port: env.PORT,
    dbPath: env.DB_PATH,
    tenantId: env.MIDPLANE_TENANT_ID,
    policyFile: env.MIDPLANE_POLICY_FILE,
    transport: env.MIDPLANE_TRANSPORT,
    indexerToken: env.INDEXER_TOKEN,
  };
  // Strip undefined so zod defaults apply.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) cleaned[k] = v;
  }

  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `Configuration error: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

export function loadPolicyFile(path: string): LoadedPolicy {
  const text = readFileSync(path, "utf8");
  return parsePolicyYaml(text, `file ${path}`);
}

// Shared YAML-text → LoadedPolicy path. Used by loadPolicyFile (boot) and the
// /admin/policy hot-reload endpoint, so both validate identically.
// `source` is a label baked into thrown error messages to disambiguate where
// the bad YAML came from in operator-facing diagnostics.
//
// `env` is needed for `${VAR}` interpolation in `databases[].url`. Defaults
// to process.env so callers don't need to plumb it; tests pass a fixture.
export function parsePolicyYaml(
  text: string,
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedPolicy {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    throw new Error(
      `Policy YAML parse error from ${source}: ${(err as Error).message}`,
    );
  }

  if (doc === null || doc === undefined) {
    return {
      databases: [
        {
          name: DEFAULT_DB_NAME,
          url: "",
          tenantScope: EMPTY_TENANT_SCOPE,
          hasTenantScope: false,
          tableAccess: null,
          hasTableAccess: false,
        },
      ],
      hasDatabasesBlock: false,
      tenantScope: EMPTY_TENANT_SCOPE,
      tableAccess: null,
      hasTenantScope: false,
      hasTableAccess: false,
    };
  }

  const parsed = PolicyFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Policy schema error from ${source}: ${formatZodIssues(parsed.error.issues)}`,
    );
  }

  const rawDoc =
    typeof doc === "object" && doc !== null
      ? (doc as Record<string, unknown>)
      : {};
  const hasDatabasesBlock = Object.prototype.hasOwnProperty.call(
    rawDoc,
    "databases",
  );

  if (hasDatabasesBlock && parsed.data.databases) {
    const databases = parsed.data.databases.map((entry, idx) =>
      resolveDatabaseEntry(entry, idx, source, env, rawDoc),
    );
    assertUniqueNames(databases, source);
    return {
      databases,
      hasDatabasesBlock: true,
      // Multi-DB shape: legacy mirror fields aren't applicable. Default to
      // empty so callers reading these (legacy hot-reload path) see a
      // consistent shape.
      tenantScope: EMPTY_TENANT_SCOPE,
      tableAccess: null,
      hasTenantScope: false,
      hasTableAccess: false,
    };
  }

  // Legacy single-DB shape — unchanged from 0.1.x. Build one synthetic
  // entry with name=__default__ and url left empty (the boot path fills
  // it from env DATABASE_URL via resolveDatabasesFromConfig).
  const hasTenantScope = Object.prototype.hasOwnProperty.call(
    rawDoc,
    "tenant_scope",
  );
  const hasTableAccess = Object.prototype.hasOwnProperty.call(
    rawDoc,
    "table_access",
  );

  const tenantScope = resolveTenantScope(
    parsed.data.tenant_scope,
    source,
    "tenant_scope",
  );

  const ta = parsed.data.table_access;
  const tableAccess = ta ? { default: ta.default, tables: ta.tables } : null;

  return {
    databases: [
      {
        name: DEFAULT_DB_NAME,
        url: "",
        tenantScope,
        hasTenantScope,
        tableAccess,
        hasTableAccess,
      },
    ],
    hasDatabasesBlock: false,
    tenantScope,
    tableAccess,
    hasTenantScope,
    hasTableAccess,
  };
}

// Normalize a parsed `tenant_scope` block into a TenantScopeSpec. Applies
// the strict-mode precedence rules and rejects `mappings` + `overrides`
// in the same document (a clear operator bug — `mappings` is the legacy
// alias for `overrides`).
//
// `path` is baked into thrown errors so multi-DB callers can disambiguate
// which entry the bad config belongs to.
function resolveTenantScope(
  raw: z.infer<typeof TenantScopeSchema> | undefined,
  source: string,
  path: string,
): TenantScopeSpec {
  if (!raw || raw.enabled === false) return EMPTY_TENANT_SCOPE;
  if (raw.mappings !== undefined && raw.overrides !== undefined) {
    throw new Error(
      `Policy schema error from ${source}: ${path} has both \`mappings\` and \`overrides\` set. \`mappings\` is the pre-0.5.0 alias for \`overrides\` — pick one.`,
    );
  }
  const overrides = raw.overrides ?? raw.mappings ?? {};
  return {
    defaultColumn: raw.column ?? null,
    overrides,
    exempt: raw.exempt ?? [],
  };
}

function resolveDatabaseEntry(
  entry: z.infer<typeof DatabaseEntrySchema>,
  idx: number,
  source: string,
  env: NodeJS.ProcessEnv,
  rawDoc: Record<string, unknown>,
): DatabaseSpec {
  if (!DB_NAME_RE.test(entry.name)) {
    throw new Error(
      `Policy schema error from ${source}: databases[${idx}].name "${entry.name}" must match ${DB_NAME_RE} (lowercase, starts with a letter, dash/underscore/digit allowed, max 32 chars)`,
    );
  }
  if (entry.name === DEFAULT_DB_NAME) {
    throw new Error(
      `Policy schema error from ${source}: databases[${idx}].name "${DEFAULT_DB_NAME}" is reserved for the legacy single-DB path`,
    );
  }

  const url = interpolateEnv(entry.url, env, source, `databases[${idx}].url`);

  const tenantScope = resolveTenantScope(
    entry.tenant_scope,
    source,
    `databases[${idx}].tenant_scope`,
  );

  const ta = entry.table_access;
  const tableAccess = ta ? { default: ta.default, tables: ta.tables } : null;

  // hasTenantScope / hasTableAccess for individual entries — read from the
  // raw doc so omit-vs-empty distinction survives. For the multi-DB shape
  // the hot-reload endpoint applies these per-entry.
  const rawDatabases = (rawDoc.databases as Array<Record<string, unknown>>) ?? [];
  const rawEntry = rawDatabases[idx] ?? {};
  const hasTenantScope = Object.prototype.hasOwnProperty.call(rawEntry, "tenant_scope");
  const hasTableAccess = Object.prototype.hasOwnProperty.call(rawEntry, "table_access");

  return {
    name: entry.name,
    url,
    tenantScope,
    hasTenantScope,
    tableAccess,
    hasTableAccess,
  };
}

function assertUniqueNames(databases: DatabaseSpec[], source: string): void {
  const seen = new Set<string>();
  for (const d of databases) {
    if (seen.has(d.name)) {
      throw new Error(
        `Policy schema error from ${source}: duplicate database name "${d.name}" in databases[]`,
      );
    }
    seen.add(d.name);
  }
}

// `${VAR}` → env[VAR]. Throws if VAR is unset or empty so a typo'd env
// reference fails loudly at boot rather than booting with an empty DSN.
// Multiple ${...} per string are supported (rare but valid). Plain strings
// pass through unchanged.
function interpolateEnv(
  value: string,
  env: NodeJS.ProcessEnv,
  source: string,
  field: string,
): string {
  return value.replace(ENV_INTERP_RE, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      throw new Error(
        `Policy YAML error from ${source}: ${field} references env var ${name} which is unset`,
      );
    }
    return v;
  });
}

// Boot-time resolution: combine a parsed LoadedPolicy with the optional env
// DATABASE_URL into the final DatabaseSpec[]. Handles the precedence rules:
//   - YAML databases[] wins. If env DATABASE_URL is also set, log a warning.
//   - Otherwise the legacy synthetic __default__ entry takes its url from
//     env DATABASE_URL. Throw with a helpful message if env is also unset.
//
// Also called from /admin/policy (with the existing engine registry's
// known DBs as `current` so we can apply the env DATABASE_URL fallback
// only when it's the legacy single-DB shape).
export function resolveDatabasesFromConfig(
  policy: LoadedPolicy,
  cfg: Config,
  warn?: (msg: string) => void,
): DatabaseSpec[] {
  if (policy.hasDatabasesBlock) {
    if (cfg.databaseUrl && warn) {
      warn(
        "DATABASE_URL is set but YAML databases[] is in use; the env DATABASE_URL is ignored.",
      );
    }
    return policy.databases;
  }

  // Legacy single-DB shape. policy.databases has one entry with url="".
  if (!cfg.databaseUrl) {
    throw new Error(
      "Configuration error: DATABASE_URL is required (or supply YAML databases[]). " +
        "Set DATABASE_URL to a Postgres DSN, e.g. postgres://user:pass@host:5432/db",
    );
  }
  return policy.databases.map((d) => ({ ...d, url: cfg.databaseUrl! }));
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
