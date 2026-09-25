// Wires Config + LoadedPolicy → EngineRegistry. All SQL execution paths
// flow through this registry — no parallel execute paths exist anywhere
// else in the server.
//
// Single-DB callers see a registry containing one Engine named
// '__default__' (the legacy synthetic name). Multi-DB callers see one
// Engine per `databases:` entry. The MCP layer queries `count` /
// `databaseNames` to reshape its tool surface.
//
// Hot-reload: each Engine carries its own table_access + tenant_scope
// holder (pointer swap on policy reload). The registry exposes a single
// `setPolicy(yamlText)` entrypoint that handles both shapes: the legacy
// single-DB body re-routes to engines.get('__default__'); the multi-DB
// shape diffs `databases[]` and adds/removes/updates engines as needed.
// Both `table_access` and `tenant_scope.mappings` swap in place via the
// holder — the engine never rebuilds for a policy edit.
//
// Gateway mode applies signed bundles through a second entrypoint,
// `replacePolicy`, with FULL-REPLACEMENT semantics: an omitted section means
// off, the apply is all-or-nothing, and a database whose masks changed gets a
// freshly built Engine on its existing pool (masks are constructor config).

import { isDeepStrictEqual } from "node:util";
import { ulid } from "ulid";
import {
  Engine,
  EnvCredentialStore,
  SqliteAuditWriter,
  parseError,
  multiStatement,
  tableAccess,
  tenantScope,
  dangerousStatement,
  dangerousFunction,
  getDialect,
  CachingCatalogResolver,
  postgresSourceRewriter,
  type AuditEvent,
  type AuditWriter,
  type CatalogQueryFn,
  type ColumnMasks,
  type CredentialStore,
  type DangerousStatementConfig,
  type EngineContext,
  type Executor,
  type MaskingConfig,
  type MaskRule,
  type SourceRewriteObserver,
  type TableAccessConfig,
  type TenantScopeConfig,
  type ApprovalGate,
} from "@midplane/engine";
import { PgPoolExecutor } from "./executor/pg-pool.ts";
import { UnconfiguredExecutor } from "./executor/unconfigured.ts";
import {
  validateDryRunRequest,
  executeDryRun,
  DryRunError,
  type DryRunResponse,
} from "./dry-run.ts";
import {
  DEFAULT_APPROVALS,
  DEFAULT_DB_NAME,
  DEFAULT_GUARDRAILS,
  EMPTY_TENANT_SCOPE,
  loadPolicyFile,
  parsePolicyYaml,
  resolveDatabasesFromConfig,
  type DatabaseSpec,
  type GuardrailsSpec,
  type ApprovalsSpec,
  type ColumnMasksSpec,
  type LoadedPolicy,
  type TableAccessLevel,
  type TenantScopeSpec,
} from "./config.ts";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

// Per-DB pointer-swap target for hot reloads. Both rules read these once
// per query (tableAccess via getter, tenantScope via getter), so an
// in-flight query never sees a half-applied swap.
export interface PolicyHolder {
  tableAccess: TableAccessConfig | undefined;
  // Resolved tenant_scope config (defaultColumn + overrides + exempt).
  // The empty form `EMPTY_TENANT_SCOPE` means "no enforcement" — the rule
  // short-circuits ALLOW when `defaultColumn === null` and `overrides`
  // is empty. Swapping the pointer in place flips enforcement cleanly.
  tenantScope: TenantScopeSpec;
  // Resolved guardrails config (block_unqualified_dml + block_ddl). Defaults
  // to DEFAULT_GUARDRAILS (both ON). The dangerous_statement rule reads this
  // via a getter once per query, so a hot-swap flips traffic cleanly.
  guardrails: GuardrailsSpec;
  // Resolved approvals config. Defaults to OFF. The engine reads this via a
  // getter once per query, so toggling approvals lands on the next statement
  // instead of needing a respawn that would drop the agent's live session.
  approvals: ApprovalsSpec;
}

// What the MCP layer holds per registered DB.
interface EngineEntry {
  name: string;
  engine: Engine;
  ctxBase: EngineContext;
  holder: PolicyHolder;
  // Owning executor so the registry can close the pool when the entry is
  // dropped. Tests inject a stub Executor that may not have close().
  executor: Executor;
  // The DSN this engine is bound to. Used by the hot-reload path to detect
  // url changes (which require a pool rebuild) versus pure policy edits.
  url: string;
  // The masks this entry's Engine was constructed with. Masking is engine
  // constructor config, so the replace path compares these to decide whether
  // the Engine must be rebuilt (see replacePolicy).
  columnMasks: ColumnMasksSpec | null;
  maskSourceRewrite: boolean | null;
  // Gateway mode: the env var this DB's DSN is read from, and whether it was
  // set. An unconfigured DB keeps its policy but has no connection — every call
  // on it fails with a message naming the variable. Null/true outside gateway
  // mode, where the DSN comes from the YAML or DATABASE_URL directly.
  dsnEnv: string | null;
  configured: boolean;
  // The dialect's metadata SQL builders, surfaced here so the list_tables /
  // describe_table tool handlers can build dialect-correct discovery SQL.
  // Engine.dialect is private, so the tools can't reach the dialect directly;
  // this is the clean seam. Postgres emits the SQL-standard information_schema
  // queries; routing through the dialect keeps the tools dialect-agnostic (a
  // future dialect without information_schema, e.g. SQLite, overrides these).
  listTablesSql: (schema: string) => string;
  describeTableSql: (schema: string, table: string) => string;
  // Schema the metadata tools use when the caller omits `schema`. Postgres →
  // "public". Resolved from the dialect, "public" fallback.
  defaultSchema: string;
}

export interface EngineRegistry {
  // Lookup by name. Throws (with a clear message naming the bad arg) when
  // the caller passes an unknown DB. Used by every tool handler.
  get(name: string): EngineEntry;
  // True iff the name is registered. Used by the MCP layer to detect
  // unknown-DB before throwing in the tool handler.
  has(name: string): boolean;
  // Sorted list of names, useful for building the MCP `database` enum and
  // for `list_databases`. Sorted to keep the tool schema stable across
  // restarts (matters when the agent caches tool definitions).
  names(): string[];
  // Same as names().length, broken out so the MCP layer can branch on
  // single-vs-multi without allocating an array.
  count(): number;
  // For the indexer pull endpoint and the audit CLI.
  audit: SqliteAuditWriter;
  // For `list_databases` — surfaces per-DB metadata without exposing the
  // EngineEntry internals. The tenant_scope fields are the live resolved
  // config; cloud callers use them to verify engine state matches what
  // their DB row says they pushed.
  describe(): Array<{
    name: string;
    tenant_scope_enabled: boolean;
    tenant_scope_column: string | null;
    tenant_scope_overrides: Record<string, string>;
    tenant_scope_exempt: string[];
    table_access_default: TableAccessLevel | null;
    guardrails_block_unqualified_dml: boolean;
    guardrails_block_ddl: boolean;
    guardrails_block_dml: boolean;
  }>;
  // Hot-swap entrypoint. Same body as 0.1.x's setPolicy — the registry
  // dispatches based on shape (legacy → swap on __default__; multi-DB →
  // diff and reconcile).
  setPolicy(yamlText: string): Promise<{ applied_at: string }>;
  // Policy dry-run ("would this SQL be allowed or denied?"). Resolves the
  // request's `database` to its live engine + policy holder and runs every
  // probe/statement through `engine.decide()` — the same decision brain the
  // `query` tool enforces, stopped before any execution. Never opens a
  // connection to the customer DB. Throws DryRunError (→ HTTP 400) on a bad
  // request shape, an unknown database alias, or unparseable custom SQL.
  dryRun(body: unknown): Promise<DryRunResponse>;
  close(): Promise<void>;
}

export interface EngineHandle {
  registry: EngineRegistry;
  /** The gate this engine was built with, if any — surfaced so the MCP layer
   *  can offer `check_approval` only when it can actually be answered. */
  approvalGate?: ApprovalGate;
  close(): Promise<void>;
}

/** One database of a verified gateway bundle, ready to apply. `spec.url` is the
 *  DSN read from `dsnEnv` when `configured`, and "" when the variable is unset. */
export interface ReplaceDatabase {
  spec: DatabaseSpec;
  dsnEnv: string;
  configured: boolean;
}

/** What a gateway reports it enforces, per database. Deliberately NOT part of
 *  describe(): that one is agent-facing (list_databases), and neither mask
 *  config nor DSN variable names are the agent's business. No DSN values, no
 *  salt, ever. */
export interface PolicySnapshotEntry {
  name: string;
  status: "ready" | "unconfigured";
  dsn_env: string | null;
  table_access_default: TableAccessLevel | null;
  table_access_tables: number;
  guardrails: { block_unqualified_dml: boolean; block_ddl: boolean; block_dml: boolean };
  approvals: { row_changes: boolean; whole_table_writes: boolean; schema_changes: boolean };
  tenant_scope: { column: string | null; overrides: Record<string, string>; exempt: string[] } | null;
  column_masks: ColumnMasksSpec | null;
  mask_source_rewrite: boolean;
}

/** The handle buildEngine returns. Adds the gateway-mode entrypoints to the
 *  EngineHandle every other consumer sees. */
export interface BuiltEngineHandle extends EngineHandle {
  /** Gateway mode: apply a verified bundle with FULL-REPLACEMENT semantics — an
   *  omitted section means off, never "keep the old one" — all-or-nothing.
   *  Throws (having changed nothing) when any database can't be built. */
  replacePolicy(
    databases: readonly ReplaceDatabase[],
    meta: { bundleVersion: number },
  ): Promise<{ applied_at: string }>;
  policySnapshot(): PolicySnapshotEntry[];
  /** Gateway halt: drop every database and its pool, recording the removal.
   *  Nothing is "applied" — the gateway serves nothing until a newer bundle
   *  applies through replacePolicy. */
  drain(meta: { bundleVersion: number; reason: string }): Promise<void>;
  /** The audit writer with wrapAudit applied (telemetry, deny webhook): what a
   *  gateway writes its own refusals through, so they alert like any denial. */
  auditWriter: AuditWriter;
}

export interface BuildEngineOptions {
  // Wraps each per-DB audit writer (e.g. with a telemetry tee). The same
  // wrapper instance is applied to all DBs — all telemetry buckets into
  // the same collector.
  wrapAudit?: (w: AuditWriter) => AuditWriter;
  // Test injection. When provided, ALL engines in the registry use the
  // same executor + credentials. Production callers leave undefined and
  // get one PgPoolExecutor per DB.
  executor?: Executor;
  credentials?: CredentialStore;
  // Approval gate for held writes. Supplied by the server when
  // MIDPLANE_APPROVAL_URL + MIDPLANE_APPROVAL_TOKEN are configured. Left
  // undefined otherwise — a policy that enables approvals without one then
  // fails closed at query time instead of running the write.
  approvalGate?: ApprovalGate;
  // Gateway mode: start with NO databases and no policy. The registry fills in
  // only when a verified bundle is applied via replacePolicy; until then there
  // is nothing to query (never received a policy ⇒ serve nothing).
  startEmpty?: boolean;
}

export function buildEngine(cfg: Config, opts: BuildEngineOptions = {}): BuiltEngineHandle {
  // ── 1. Load YAML (if any) and resolve to a DatabaseSpec[] ─────────────
  let policy: LoadedPolicy;
  if (opts.startEmpty) {
    policy = {
      databases: [],
      hasDatabasesBlock: true,
      tenantScope: EMPTY_TENANT_SCOPE,
      tableAccess: null,
      hasTenantScope: false,
      hasTableAccess: false,
      guardrails: DEFAULT_GUARDRAILS,
      hasGuardrails: false,
      columnMasks: null,
      hasColumnMasks: false,
    };
  } else if (cfg.policyFile) {
    policy = loadPolicyFile(cfg.policyFile);
  } else {
    // No YAML → synthetic legacy shape with a single default DB.
    policy = {
      databases: [
        {
          name: DEFAULT_DB_NAME,
          url: "",
          dialect: "postgres",
          tenantScope: EMPTY_TENANT_SCOPE,
          hasTenantScope: false,
          tableAccess: null,
          hasTableAccess: false,
          // No YAML still gets the default-ON guardrails safety net.
          guardrails: DEFAULT_GUARDRAILS,
          hasGuardrails: false,
          columnMasks: null,
          hasColumnMasks: false,
          maskSourceRewrite: null,
        },
      ],
      hasDatabasesBlock: false,
      tenantScope: EMPTY_TENANT_SCOPE,
      tableAccess: null,
      hasTenantScope: false,
      hasTableAccess: false,
      guardrails: DEFAULT_GUARDRAILS,
      hasGuardrails: false,
      columnMasks: null,
      hasColumnMasks: false,
    };
  }
  const specs = resolveDatabasesFromConfig(policy, cfg, (msg) =>
    logger.warn({ msg }, "policy resolution warning"),
  );

  // ── 2. Single shared SQLite audit writer ──────────────────────────────
  // All engines write to the same sqlite file; rows are tagged with the
  // owning DB name via Engine.databaseName so consumers can filter.
  const baseAudit = new SqliteAuditWriter(cfg.dbPath);
  const audit = opts.wrapAudit ? opts.wrapAudit(baseAudit) : baseAudit;
  const credentials =
    opts.credentials ?? new EnvCredentialStore("DATABASE_URL");

  // ── 3. Build one EngineEntry per spec ─────────────────────────────────
  const entries = new Map<string, EngineEntry>();
  for (const spec of specs) {
    entries.set(spec.name, makeEngineEntry(spec, cfg, audit, credentials, opts));
  }

  if (cfg.policyFile) {
    logger.info(
      {
        policyFile: cfg.policyFile,
        databases: specs.map((s) => ({
          name: s.name,
          tenantScope: {
            column: s.tenantScope.defaultColumn,
            overrides: Object.keys(s.tenantScope.overrides),
            exempt: s.tenantScope.exempt,
          },
          tableAccess: s.tableAccess
            ? { default: s.tableAccess.default, tables: Object.keys(s.tableAccess.tables) }
            : null,
        })),
      },
      "policy file loaded",
    );
  }

  // ── 4. setPolicy: dispatches by shape ─────────────────────────────────
  const setPolicy = async (yamlText: string): Promise<{ applied_at: string }> => {
    const next = parsePolicyYaml(yamlText, "admin endpoint");

    if (next.hasDatabasesBlock) {
      return swapMultiDb(next, cfg, audit, credentials, opts, entries, baseAudit);
    }

    // Legacy single-DB shape. Body MUST contain table_access (omitting it
    // would silently reset to the no-YAML default and widen permissions);
    // tenant_scope is optional — omitted means "don't touch".
    if (!next.hasTableAccess || !next.tableAccess) {
      throw new Error(
        "Policy body is missing the required `table_access` section. " +
          "Hot-swap requires table_access — sending other sections alone " +
          "would clear the current table_access policy.",
      );
    }
    const target = entries.get(DEFAULT_DB_NAME);
    if (!target) {
      // The engine was booted with a multi-DB YAML but the operator is
      // posting the legacy shape. Refuse — the legacy shape can't pick
      // out which DB it means to update.
      throw new Error(
        "Engine is configured with a `databases:` block; legacy single-DB hot-swap (top-level `table_access`) is not accepted. " +
          "Send a `databases:` body whose entries name the DBs to update.",
      );
    }
    // Compute diffs against the current holder BEFORE mutating, so the
    // POLICY_RELOADED audit row can name what changed. Tenant scope
    // section semantics: explicit body = swap; omitted = "don't touch"
    // (matches table_access — the absent-section rule is preserved
    // identically across both sections so a body editing one alone never
    // accidentally clears the other).
    const newTableAccess: TableAccessConfig = {
      default: next.tableAccess.default,
      tables: next.tableAccess.tables,
    };
    const tableAccessDiff = diffTableAccess(target.holder.tableAccess, newTableAccess);
    const tenantScopeDiff = next.hasTenantScope
      ? diffTenantScope(target.holder.tenantScope, next.tenantScope)
      : null;
    // Guardrails follow tenant_scope's omit-vs-set rule: an explicit
    // `guardrails` body swaps; omitting it leaves the current guardrails
    // untouched (so a body editing table_access alone never re-opens DDL/DML).
    const guardrailsDiff = next.hasGuardrails
      ? diffGuardrails(target.holder.guardrails, next.guardrails)
      : null;

    target.holder.tableAccess = newTableAccess;
    if (next.hasTenantScope) {
      target.holder.tenantScope = next.tenantScope;
    }
    if (next.hasGuardrails) {
      target.holder.guardrails = { ...next.guardrails };
    }
    // Same omit-vs-set rule. Without this branch a policy push that turns
    // approvals ON lands in the control plane's database and never reaches a
    // warm engine — so writes would keep executing unapproved until the next
    // respawn, which is the one failure this feature cannot have.
    if (next.hasApprovals) {
      target.holder.approvals = { ...next.approvals };
    }

    return finalizeReload(cfg, baseAudit, "admin_endpoint", [
      {
        name: target.name,
        tableAccess: target.holder.tableAccess,
        tenantScope: target.holder.tenantScope,
        guardrails: target.holder.guardrails,
        tableAccessDiff,
        tenantScopeDiff,
        guardrailsDiff,
        kind: "swapped",
      },
    ]);
  };

  const registry: EngineRegistry = {
    get(name) {
      const e = entries.get(name);
      if (!e) {
        throw new Error(
          `Unknown database "${name}". Configured databases: ${[...entries.keys()].sort().join(", ")}.`,
        );
      }
      return e;
    },
    has(name) {
      return entries.has(name);
    },
    names() {
      return [...entries.keys()].sort();
    },
    count() {
      return entries.size;
    },
    audit: baseAudit,
    describe() {
      return [...entries.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const ts = e.holder.tenantScope;
          return {
            name: e.name,
            tenant_scope_enabled:
              ts.defaultColumn !== null || Object.keys(ts.overrides).length > 0,
            tenant_scope_column: ts.defaultColumn,
            // Shallow-copy so callers (including JSON serializers) can't
            // mutate the live holder.
            tenant_scope_overrides: { ...ts.overrides },
            tenant_scope_exempt: [...ts.exempt],
            table_access_default: e.holder.tableAccess
              ? e.holder.tableAccess.default
              : null,
            guardrails_block_unqualified_dml: e.holder.guardrails.blockUnqualifiedDml,
            guardrails_block_ddl: e.holder.guardrails.blockDdl,
            guardrails_block_dml: e.holder.guardrails.blockDml,
          };
        });
    },
    setPolicy,
    async dryRun(body: unknown): Promise<DryRunResponse> {
      // Validate first so a malformed body yields a precise error (and so the
      // `database` field is well-typed before we resolve it).
      const req = validateDryRunRequest(body);
      const entry = entries.get(req.database);
      if (!entry) {
        throw new DryRunError(
          `Unknown database "${req.database}". Configured databases: ${[...entries.keys()].sort().join(", ")}.`,
        );
      }
      // Hand the dry-run the entry's LIVE engine + holder pointers, so a
      // verdict reflects the current (hot-swappable) policy and is computed by
      // the exact engine the `query` tool drives.
      return executeDryRun(
        {
          engine: entry.engine,
          tableAccess: entry.holder.tableAccess,
          tenantScope: entry.holder.tenantScope,
          guardrails: entry.holder.guardrails,
          ctxBase: entry.ctxBase,
        },
        req,
      );
    },
    async close() {
      // Drain every per-DB executor pool; only the underlying SQLite gets
      // close()'d (audit may be a wrapper).
      for (const e of entries.values()) {
        const maybeClose = (e.executor as { close?: () => Promise<void> }).close;
        if (typeof maybeClose === "function") {
          await maybeClose.call(e.executor).catch((err) => {
            logger.warn({ err, db: e.name }, "executor close failed");
          });
        }
      }
      await audit.close();
    },
  };

  return {
    registry,
    approvalGate: opts.approvalGate,
    replacePolicy: (databases, meta) =>
      replaceAllDatabases(databases, meta, cfg, audit, credentials, opts, entries, baseAudit),
    policySnapshot: () => snapshotPolicy(entries, cfg),
    drain: (meta) => drainAllDatabases(meta, cfg, opts, entries, baseAudit),
    auditWriter: audit,
    async close() {
      await registry.close();
    },
  };
}

// Gateway-mode extras for makeEngineEntry. `reuseExecutor` keeps an existing
// pool when only engine-construction config (masks) changed, so a mask edit
// never churns the customer's database connections.
interface GatewayEntryOptions {
  dsnEnv: string;
  configured: boolean;
  reuseExecutor?: Executor;
}

// Build an EngineEntry from a single resolved DatabaseSpec. Used at boot, by
// the hot-reload path when adding a previously-unseen DB, and by the gateway
// replace path (which also rebuilds an entry whose masks changed).
function makeEngineEntry(
  spec: DatabaseSpec,
  cfg: Config,
  audit: AuditWriter,
  credentials: CredentialStore,
  opts: BuildEngineOptions,
  gw?: GatewayEntryOptions,
): EngineEntry {
  // Tests inject one shared executor across DBs (for back-compat with
  // single-engine tests). Production gets one Postgres pool per DB. A gateway
  // DB whose DSN variable is unset gets an executor that refuses everything,
  // whatever the test injection — "not configured" must not depend on it.
  let executor: Executor;
  let ownsExecutor = false;
  if (gw && !gw.configured) {
    executor = new UnconfiguredExecutor(spec.name, gw.dsnEnv);
  } else if (gw?.reuseExecutor) {
    executor = gw.reuseExecutor;
  } else if (opts.executor) {
    executor = opts.executor;
  } else {
    executor = new PgPoolExecutor({ databaseUrl: spec.url });
    ownsExecutor = true;
  }
  try {
    return buildEntryWith(spec, cfg, audit, credentials, opts, executor, gw);
  } catch (err) {
    // A throw here (e.g. masks the executor can't back) must not strand the
    // pool we just opened.
    if (ownsExecutor) void closeExecutor(executor, spec.name, "entry build failed");
    throw err;
  }
}

function buildEntryWith(
  spec: DatabaseSpec,
  cfg: Config,
  audit: AuditWriter,
  credentials: CredentialStore,
  opts: BuildEngineOptions,
  executor: Executor,
  gw: GatewayEntryOptions | undefined,
): EngineEntry {
  const holder: PolicyHolder = {
    tableAccess: spec.tableAccess
      ? { default: spec.tableAccess.default, tables: spec.tableAccess.tables }
      : undefined,
    tenantScope: cloneTenantScope(spec.tenantScope),
    guardrails: { ...spec.guardrails },
    approvals: { ...spec.approvals },
  };

  // Resolve the dialect for this DB. Postgres is a stateless singleton; one
  // instance is shared by the engine (parse/normalize) AND the metadata SQL
  // builders exposed on the EngineEntry.
  const dialect = getDialect(spec.dialect);

  const engine = new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(() => holder.tableAccess),
        // Same getter pattern as tableAccess: the rule reads holder.tenantScope
        // once per finalize() so a swap mid-traffic flips queries cleanly
        // between old and new config without rebuilding the engine.
        tenantScope((): TenantScopeConfig => holder.tenantScope),
        // Wired LAST: the destructive-op net fires only for statements
        // table_access + tenant_scope permitted, so a more-specific rule's
        // reason surfaces when one applies. Reads the holder via getter for
        // hot-swap, same as the rules above.
        dangerousStatement((): DangerousStatementConfig => holder.guardrails),
        // Ungated and last. Refuses functions that read/write data outside the
        // relations the statement names (query_to_xml, pg_read_file, dblink, …)
        // — invisible to every rule above because they surface no table
        // reference. No config source: there is no legitimate agent-analytics
        // reason to call one, so there is no key to turn it off.
        dangerousFunction(),
      ],
    },
    audit,
    credentials,
    executor,
    databaseName: spec.name,
    // Column masking (W3:A). Built from the resolved spec + the pool-backed
    // catalog resolver; undefined when this DB declares no masks. Constructor
    // config: the patch hot-reload can't change it (a hosted masks edit
    // respawns), and the gateway replace path rebuilds the Engine instead.
    masking: buildMaskingConfig(spec, cfg, executor),
    // Write approvals. The getter mirrors the rules' hot-swap pattern. The gate
    // comes from the server (HTTP-backed when MIDPLANE_APPROVAL_URL is set);
    // when approvals are on and no gate was supplied the engine's refusing gate
    // errors rather than letting the write through.
    approvals: {
      config: (): ApprovalsSpec => holder.approvals,
      gate: opts.approvalGate,
    },
    // Resolved per-DB from the YAML `dialect:` key (defaults to "postgres"
    // when omitted). The engine routes parse() + normalize() through this;
    // the same instance backs the metadata SQL on the EngineEntry.
    dialect,
  });

  // Every registered dialect provides metadata SQL builders (postgres + mysql
  // do). The guard is defensive — a dialect added without them would fail
  // loudly at boot rather than silently breaking schema discovery.
  if (!dialect.listTablesSql || !dialect.describeTableSql) {
    throw new Error(
      `Dialect "${spec.dialect}" does not provide list_tables/describe_table SQL builders.`,
    );
  }
  const listTablesSql = dialect.listTablesSql.bind(dialect);
  const describeTableSql = dialect.describeTableSql.bind(dialect);
  const defaultSchema = dialect.defaultMetadataSchema ?? "public";

  // The rule now reads mappings from the holder (via getter), not from
  // ctx. Keep ctxBase free of `tenant_scope` so there's a single source of
  // truth for the live mappings: engineEntry.holder.tenantScope.
  const ctxBase: EngineContext = {
    tenant_id: cfg.tenantId,
    // Per-session agent name/version come from MCP `clientInfo` and the
    // per-session `mcp_token_id` comes from the X-Midplane-Token-Id
    // header; both are overlaid by buildServer's ctxFor. ctxBase carries
    // the null defaults so non-MCP callers (admin endpoints, future
    // tooling) get a well-typed ctx without crossing the MCP layer.
    agent_name: null,
    agent_version: null,
    mcp_token_id: null,
    role: "agent_readonly",
  };

  return {
    name: spec.name,
    engine,
    ctxBase,
    holder,
    executor,
    url: spec.url,
    columnMasks: spec.columnMasks,
    maskSourceRewrite: spec.maskSourceRewrite,
    dsnEnv: gw?.dsnEnv ?? null,
    configured: gw?.configured ?? true,
    listTablesSql,
    describeTableSql,
    defaultSchema,
  };
}

async function closeExecutor(executor: Executor, db: string, why: string): Promise<void> {
  const maybeClose = (executor as { close?: () => Promise<void> }).close;
  if (typeof maybeClose !== "function") return;
  await maybeClose.call(executor).catch((err) => {
    logger.warn({ err, db }, `executor close failed (${why})`);
  });
}

// Build the engine's MaskingConfig from a resolved DatabaseSpec, or undefined
// when the DB declares no masks. Fail-closed: declared masks without a salt, or
// an executor that can't run catalog queries, refuse to boot rather than mask
// weakly or not at all.
function buildMaskingConfig(
  spec: DatabaseSpec,
  cfg: Config,
  executor: Executor,
): MaskingConfig | undefined {
  if (!spec.columnMasks || Object.keys(spec.columnMasks).length === 0) {
    return undefined;
  }
  if (!cfg.maskSalt) {
    throw new Error(
      `Database "${spec.name}" declares column_masks but MIDPLANE_MASK_SALT is not set. ` +
        "Refusing to boot — masking without a salt would make the deterministic transforms predictable.",
    );
  }
  const q = (executor as Partial<{ query: CatalogQueryFn }>).query;
  if (typeof q !== "function") {
    throw new Error(
      `Database "${spec.name}" declares column_masks but its executor cannot run catalog queries (no query()).`,
    );
  }
  const queryFn: CatalogQueryFn = (sql, params) => q.call(executor, sql, params);

  const columnMasks: ColumnMasks = new Map(
    Object.entries(spec.columnMasks).map(([table, cols]) => [
      table,
      new Map(
        Object.entries(cols).map(([col, rule]) => [col, rule as MaskRule]),
      ),
    ]),
  );

  // Source-rewrite enforcement (ISSUE-007). Per-DB `mask_source_rewrite:` YAML
  // wins; otherwise inherit the engine-wide MIDPLANE_MASK_SOURCE_REWRITE default
  // (one engine per project ⇒ that env flag is per-project). OFF ⇒ the engine
  // falls back to the retained post-exec masker (byte-identical to today), so
  // flipping this is always safe. The rewriter is the Postgres span-splice +
  // covert-channel gate; the engine only invokes it when `enabled` AND the
  // executor supports transactions (PgPoolExecutor does).
  const sourceRewriteEnabled = spec.maskSourceRewrite ?? cfg.maskSourceRewrite;

  return {
    columnMasks,
    salt: cfg.maskSalt,
    resolver: new CachingCatalogResolver(queryFn),
    sourceRewrite: {
      enabled: sourceRewriteEnabled,
      rewriter: postgresSourceRewriter,
      // A2 observability: the engine is dep-free, so it emits masking signals
      // through this sink. Reject metrics ride the audit log's `masking_stage`;
      // these are the operator-facing debug/alert lines the audit shouldn't carry.
      observer: makeSourceRewriteObserver(spec.name),
    },
  };
}

// Bridge the engine's dep-free source-rewrite signals to the mcp-server pino
// logger. A stable `event: "mask_source_rewrite"` tag makes each signal a
// log-derived metric; the salt-redacted rewritten SQL lands at debug so it's
// available for reconstructing a masking complaint without being on by default.
function makeSourceRewriteObserver(db: string): SourceRewriteObserver {
  return (signal) => {
    switch (signal.kind) {
      case "rewritten":
        logger.debug(
          { event: "mask_source_rewrite", kind: signal.kind, db, masked: signal.maskedColumns, sql: signal.redactedSql },
          "masking: executed rewritten query",
        );
        return;
      case "exec_error":
        // The rewritten SQL is OURS — a failure here is our emission bug or a
        // genuine user error; either way the agent gets a sanitized error while the
        // operator gets the (salt-redacted) detail. warn so it surfaces in ops.
        logger.warn(
          { event: "mask_source_rewrite", kind: signal.kind, db, sqlstate: signal.sqlstate, message: signal.message, sql: signal.redactedSql },
          "masking: rewritten query failed at the database",
        );
        return;
      case "fallback":
        // Flag is on but the executor couldn't open a transaction — a
        // misconfiguration; masking still enforced via the post-exec masker.
        logger.warn(
          { event: "mask_source_rewrite", kind: signal.kind, db, reason: signal.reason },
          "masking: source-rewrite fell back to the post-exec masker",
        );
        return;
    }
  };
}

// Multi-DB hot-swap. Reconciles the current entries against the new spec:
//   - new entry → add (build a new engine + pool)
//   - removed entry → drop (drain pool first)
//   - same name, different url → drop + re-add (pool rebuild logged loudly)
//   - same name, same url → in-place table_access / mappings update
async function swapMultiDb(
  next: LoadedPolicy,
  cfg: Config,
  audit: AuditWriter,
  credentials: CredentialStore,
  opts: BuildEngineOptions,
  entries: Map<string, EngineEntry>,
  baseAudit: SqliteAuditWriter,
): Promise<{ applied_at: string }> {
  // Resolve to specs (no env DATABASE_URL fallback in hot-reload — the
  // body must self-describe). Throws on env interpolation failure, just
  // like boot does.
  const specs = next.databases;

  // Validation pass (don't mutate anything yet — operator deserves the
  // same all-or-nothing guarantee 0.1.x has).
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name)) {
      throw new Error(`databases[] contains duplicate name "${s.name}"`);
    }
    seen.add(s.name);
    const existing = entries.get(s.name);

    // tenant_scope.mappings now hot-swap via the holder (same pattern as
    // table_access). Body explicitly carrying `tenant_scope` ⇒ swap;
    // omitted ⇒ "don't touch". The omit-vs-set distinction matches
    // table_access so a body editing one section never silently clears
    // the other.

    // table_access requirement on existing entries. If the body omits
    // table_access for a DB that's already in the registry, applying
    // s.tableAccess === null would reset the engine to the no-YAML
    // default (default: read), silently widening permissions on a DB
    // that had a stricter policy. The legacy single-DB hot-reload
    // already requires table_access for the same reason; mirror that
    // strictness here. New entries are allowed to omit table_access —
    // they're being added fresh, no prior policy to silently clear.
    if (existing && (!s.hasTableAccess || !s.tableAccess)) {
      throw new Error(
        `databases[name=${s.name}] is missing the required \`table_access\` section. Hot-swap of an existing DB must include table_access; omitting it would silently reset the policy to the no-YAML default. Re-send the current table_access or send the value you want.`,
      );
    }
  }

  const summaries: ReloadSummary[] = [];
  const toRemove = new Set(entries.keys());

  for (const spec of specs) {
    toRemove.delete(spec.name);
    const existing = entries.get(spec.name);
    if (!existing) {
      const fresh = makeEngineEntry(spec, cfg, audit, credentials, opts);
      entries.set(spec.name, fresh);
      logger.info({ db: spec.name }, "hot reload added database");
      // New DB: prior state is nothing. Compute diffs against the empty
      // baseline so the audit row names exactly which tables/mappings
      // the operator just added — and so `databases_changed` /
      // `sections_changed` pick this DB up. (Without this, a successful
      // /admin/policy that adds a DB would emit a row reporting "no
      // changes", invisible to the cloud audit dashboard's change feed.)
      summaries.push({
        name: spec.name,
        tableAccess: fresh.holder.tableAccess,
        tenantScope: fresh.holder.tenantScope,
        guardrails: fresh.holder.guardrails,
        tableAccessDiff: fresh.holder.tableAccess
          ? diffTableAccess(undefined, fresh.holder.tableAccess)
          : null,
        tenantScopeDiff: tenantScopeIsActive(fresh.holder.tenantScope)
          ? diffTenantScope(EMPTY_TENANT_SCOPE, fresh.holder.tenantScope)
          : null,
        // Diff a brand-new DB's guardrails against the default-ON baseline so
        // the row names any explicit opt-out (e.g. block_ddl: false) the
        // operator added; a default-ON new DB produces an empty diff.
        guardrailsDiff: diffGuardrails(DEFAULT_GUARDRAILS, fresh.holder.guardrails),
        kind: "added",
      });
      continue;
    }

    if (existing.url !== spec.url) {
      // URL change: drain + rebuild. Same name, but a fundamentally
      // different connection target — log loudly so an operator
      // accidentally pointing prod at staging sees it in ops.
      logger.warn(
        { db: spec.name, oldUrl: maskDsn(existing.url), newUrl: maskDsn(spec.url) },
        "hot reload changing database url — pool will be rebuilt",
      );
      // Snapshot the OLD holder before we replace the entry — the diff
      // is meaningful: an operator pointing prod's URL at staging
      // should see what their stricter prod policy turned into.
      const prevTableAccess = existing.holder.tableAccess;
      const prevTenantScope = existing.holder.tenantScope;
      const prevGuardrails = existing.holder.guardrails;
      const maybeClose = (existing.executor as { close?: () => Promise<void> }).close;
      if (typeof maybeClose === "function") {
        await maybeClose.call(existing.executor).catch((err) => {
          logger.warn({ err, db: spec.name }, "executor close on url change failed");
        });
      }
      const fresh = makeEngineEntry(spec, cfg, audit, credentials, opts);
      entries.set(spec.name, fresh);
      summaries.push({
        name: spec.name,
        tableAccess: fresh.holder.tableAccess,
        tenantScope: fresh.holder.tenantScope,
        guardrails: fresh.holder.guardrails,
        // URL change is validated to require table_access, so
        // fresh.holder.tableAccess is always defined here.
        tableAccessDiff: fresh.holder.tableAccess
          ? diffTableAccess(prevTableAccess, fresh.holder.tableAccess)
          : null,
        tenantScopeDiff: diffTenantScope(
          prevTenantScope,
          fresh.holder.tenantScope,
        ),
        guardrailsDiff: diffGuardrails(prevGuardrails, fresh.holder.guardrails),
        kind: "rebuilt",
      });
      continue;
    }

    // Same url — in-place swap. Pointer swap on the holder for both
    // sections. table_access is required (validated above); tenant_scope
    // is opt-in per body (omit ⇒ "don't touch", carries through unchanged).
    const newTableAccess: TableAccessConfig = {
      default: spec.tableAccess!.default,
      tables: spec.tableAccess!.tables,
    };
    const tableAccessDiff = diffTableAccess(existing.holder.tableAccess, newTableAccess);
    const tenantScopeDiff = spec.hasTenantScope
      ? diffTenantScope(existing.holder.tenantScope, spec.tenantScope)
      : null;
    const guardrailsDiff = spec.hasGuardrails
      ? diffGuardrails(existing.holder.guardrails, spec.guardrails)
      : null;

    existing.holder.tableAccess = newTableAccess;
    if (spec.hasTenantScope) {
      existing.holder.tenantScope = spec.tenantScope;
    }
    if (spec.hasGuardrails) {
      existing.holder.guardrails = { ...spec.guardrails };
    }
    // Multi-DB is the shape the cloud always emits, so this — not the legacy
    // single-DB swap above — is the branch a hosted toggle actually travels
    // through. Missing it means the control plane records "approvals on" while
    // the warm engine keeps running writes unapproved.
    if (spec.hasApprovals) {
      existing.holder.approvals = { ...spec.approvals };
    }

    summaries.push({
      name: spec.name,
      tableAccess: existing.holder.tableAccess,
      tenantScope: existing.holder.tenantScope,
      guardrails: existing.holder.guardrails,
      tableAccessDiff,
      tenantScopeDiff,
      guardrailsDiff,
      kind: "swapped",
    });
  }

  for (const name of toRemove) {
    const dropped = entries.get(name)!;
    entries.delete(name);
    const maybeClose = (dropped.executor as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === "function") {
      await maybeClose.call(dropped.executor).catch((err) => {
        logger.warn({ err, db: name }, "executor close on drop failed");
      });
    }
    logger.info({ db: name }, "hot reload removed database");
  }

  return finalizeReload(cfg, baseAudit, "admin_endpoint", summaries);
}

// Gateway full-replacement apply. Where swapMultiDb PATCHES (an omitted
// section means "keep the old one", which is why switching approvals off never
// reaches a warm hosted engine), this applies the resolved spec of every
// database unconditionally: omitted tenant_scope / approvals / column_masks are
// OFF. table_access and guardrails have no safe "off", so a database without
// them is refused outright (the bundle checker refuses them first).
//
// All-or-nothing. PREPARE builds every Engine the new policy needs without
// touching a live entry — a new database, a changed connection, or changed
// masks (masking is Engine constructor config, so a mask edit rebuilds the
// Engine, reusing its pool). Any throw there discards what was built and leaves
// enforcement exactly as it was. COMMIT then swaps every entry in one
// synchronous pass: prepare and commit contain no await, so no query can observe
// a half-applied bundle. Tool handlers resolve registry.get() per call, so an
// in-flight statement finishes on the Engine it started on and the next one
// gets the new policy — no restart, no dropped MCP session.
async function replaceAllDatabases(
  databases: readonly ReplaceDatabase[],
  meta: { bundleVersion: number },
  cfg: Config,
  audit: AuditWriter,
  credentials: CredentialStore,
  opts: BuildEngineOptions,
  entries: Map<string, EngineEntry>,
  baseAudit: SqliteAuditWriter,
): Promise<{ applied_at: string }> {
  const incoming = new Set<string>();
  for (const d of databases) {
    if (incoming.has(d.spec.name)) {
      throw new Error(`bundle lists database "${d.spec.name}" more than once`);
    }
    incoming.add(d.spec.name);
    if (!d.spec.hasTableAccess || !d.spec.tableAccess) {
      throw new Error(`bundle database "${d.spec.name}" has no table_access; refusing rather than fall back to the permissive default`);
    }
    if (!d.spec.hasGuardrails) {
      throw new Error(`bundle database "${d.spec.name}" has no guardrails section`);
    }
  }

  // ── PREPARE ────────────────────────────────────────────────────────────
  type Plan =
    | { kind: "added"; next: EngineEntry }
    | { kind: "rebuilt"; prev: EngineEntry; next: EngineEntry; closePrev: boolean }
    | { kind: "swapped"; prev: EngineEntry; spec: DatabaseSpec };
  const plans: Plan[] = [];
  const opened: EngineEntry[] = [];
  try {
    for (const d of databases) {
      const gw: GatewayEntryOptions = { dsnEnv: d.dsnEnv, configured: d.configured };
      const prev = entries.get(d.spec.name);
      if (!prev) {
        const next = makeEngineEntry(d.spec, cfg, audit, credentials, opts, gw);
        opened.push(next);
        plans.push({ kind: "added", next });
      } else if (prev.url !== d.spec.url || prev.configured !== d.configured || prev.dsnEnv !== d.dsnEnv) {
        const next = makeEngineEntry(d.spec, cfg, audit, credentials, opts, gw);
        opened.push(next);
        plans.push({ kind: "rebuilt", prev, next, closePrev: true });
      } else if (!sameMasks(prev, d.spec)) {
        const next = makeEngineEntry(d.spec, cfg, audit, credentials, opts, {
          ...gw,
          reuseExecutor: prev.executor,
        });
        plans.push({ kind: "rebuilt", prev, next, closePrev: false });
      } else {
        plans.push({ kind: "swapped", prev, spec: d.spec });
      }
    }
  } catch (err) {
    for (const e of opened) {
      if (e.executor !== opts.executor) void closeExecutor(e.executor, e.name, "bundle refused");
    }
    throw err;
  }

  // ── COMMIT (synchronous) ───────────────────────────────────────────────
  const toClose: Array<{ executor: Executor; db: string }> = [];
  const summaries: ReloadSummary[] = [];
  for (const plan of plans) {
    if (plan.kind === "added") {
      entries.set(plan.next.name, plan.next);
      summaries.push(replaceSummary(null, plan.next, "added"));
    } else if (plan.kind === "rebuilt") {
      entries.set(plan.next.name, plan.next);
      if (plan.closePrev) toClose.push({ executor: plan.prev.executor, db: plan.prev.name });
      summaries.push(replaceSummary(plan.prev, plan.next, "rebuilt"));
    } else {
      const before = snapshotEntry(plan.prev);
      const h = plan.prev.holder;
      h.tableAccess = { default: plan.spec.tableAccess!.default, tables: plan.spec.tableAccess!.tables };
      h.tenantScope = cloneTenantScope(plan.spec.tenantScope);
      h.guardrails = { ...plan.spec.guardrails };
      h.approvals = { ...plan.spec.approvals };
      summaries.push(replaceSummary(before, plan.prev, "swapped"));
    }
  }
  const removed: string[] = [];
  for (const [name, e] of [...entries]) {
    if (!incoming.has(name)) {
      entries.delete(name);
      toClose.push({ executor: e.executor, db: name });
      removed.push(name);
      logger.info({ db: name }, "bundle removed database");
    }
  }

  // Drain replaced pools OFF the apply path. pg's end() resolves only once every
  // checked-out client is released, so awaiting it here would hold the gateway's
  // next bundle — a pause included — behind whatever long query is running.
  for (const c of toClose) {
    if (c.executor !== opts.executor) void closeExecutor(c.executor, c.db, "replaced by bundle");
  }
  await writeRemovalRows(cfg, baseAudit, removed, { source: "bundle", bundleVersion: meta.bundleVersion });
  return finalizeReload(cfg, baseAudit, "bundle", summaries, { bundleVersion: meta.bundleVersion });
}

async function drainAllDatabases(
  meta: { bundleVersion: number; reason: string },
  cfg: Config,
  opts: BuildEngineOptions,
  entries: Map<string, EngineEntry>,
  baseAudit: SqliteAuditWriter,
): Promise<void> {
  const removed = [...entries.keys()].sort();
  for (const [name, e] of [...entries]) {
    entries.delete(name);
    if (e.executor !== opts.executor) void closeExecutor(e.executor, name, "gateway halted");
  }
  logger.info({ databases: removed, bundleVersion: meta.bundleVersion }, "gateway halted: databases drained");
  await writeRemovalRows(cfg, baseAudit, removed, {
    source: "halt",
    bundleVersion: meta.bundleVersion,
    reason: meta.reason,
  });
}

// One POLICY_RELOADED row per database a gateway stopped serving — dropped by a
// bundle, or drained by a halt — so the audit log alone shows when enforcement
// on a database ended and why. Best-effort, like every reload row.
async function writeRemovalRows(
  cfg: Config,
  audit: SqliteAuditWriter,
  removed: readonly string[],
  meta: { source: "bundle" | "halt"; bundleVersion: number; reason?: string },
): Promise<void> {
  for (const name of removed) {
    const event = {
      id: ulid(),
      query_id: ulid(),
      tenant_id: cfg.tenantId,
      database: name,
      agent_name: null,
      agent_version: null,
      agent_intent: null,
      mcp_token_id: null,
      ts: Date.now(),
      schema_version: 3,
      event_type: "POLICY_RELOADED",
      payload: {
        source: meta.source,
        removed: true,
        bundle_version: meta.bundleVersion,
        ...(meta.reason ? { reason: meta.reason } : {}),
        sections_changed: [],
        databases_changed: [...removed],
        table_access: null,
      },
    } as unknown as AuditEvent;
    try {
      await audit.write(event);
    } catch (err) {
      logger.error({ err, db: name }, "database removal applied but audit write failed");
    }
  }
}

// Masks are Engine constructor config: equal masks (and the same enforcement
// mode) mean the running Engine can stay.
function sameMasks(entry: EngineEntry, spec: DatabaseSpec): boolean {
  return (
    isDeepStrictEqual(nonEmptyMasks(entry.columnMasks), nonEmptyMasks(spec.columnMasks)) &&
    (entry.maskSourceRewrite ?? null) === (spec.maskSourceRewrite ?? null)
  );
}

function nonEmptyMasks(m: ColumnMasksSpec | null): ColumnMasksSpec | null {
  if (!m) return null;
  const kept = Object.entries(m).filter(([, cols]) => Object.keys(cols).length > 0);
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

// The policy-relevant state of an entry, frozen — the "before" side of a diff
// when the entry's holder is about to be mutated in place.
interface EntryState {
  tableAccess: TableAccessConfig | undefined;
  tenantScope: TenantScopeSpec;
  guardrails: GuardrailsSpec;
  approvals: ApprovalsSpec;
  columnMasks: ColumnMasksSpec | null;
}

function snapshotEntry(e: EngineEntry): EntryState {
  return {
    tableAccess: e.holder.tableAccess,
    tenantScope: cloneTenantScope(e.holder.tenantScope),
    guardrails: { ...e.holder.guardrails },
    approvals: { ...e.holder.approvals },
    columnMasks: nonEmptyMasks(e.columnMasks),
  };
}

function replaceSummary(
  before: EntryState | EngineEntry | null,
  after: EngineEntry,
  kind: ReloadSummary["kind"],
): ReloadSummary {
  const prev = before === null ? null : "holder" in before ? snapshotEntry(before) : before;
  const nextMasks = nonEmptyMasks(after.columnMasks);
  return {
    name: after.name,
    tableAccess: after.holder.tableAccess,
    tenantScope: after.holder.tenantScope,
    guardrails: after.holder.guardrails,
    tableAccessDiff: after.holder.tableAccess
      ? diffTableAccess(prev?.tableAccess, after.holder.tableAccess)
      : null,
    tenantScopeDiff: diffTenantScope(prev?.tenantScope ?? EMPTY_TENANT_SCOPE, after.holder.tenantScope),
    guardrailsDiff: diffGuardrails(prev?.guardrails ?? DEFAULT_GUARDRAILS, after.holder.guardrails),
    approvals: after.holder.approvals,
    approvalsDiff: diffApprovals(prev?.approvals ?? DEFAULT_APPROVALS, after.holder.approvals),
    columnMasks: nextMasks,
    columnMasksDiff: diffColumnMasks(prev?.columnMasks ?? null, nextMasks),
    kind,
  };
}

function snapshotPolicy(entries: Map<string, EngineEntry>, cfg: Config): PolicySnapshotEntry[] {
  return [...entries.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const ts = e.holder.tenantScope;
      const masks = nonEmptyMasks(e.columnMasks);
      const approvals = e.holder.approvals;
      return {
        name: e.name,
        status: e.configured ? "ready" : "unconfigured",
        dsn_env: e.dsnEnv,
        table_access_default: e.holder.tableAccess ? e.holder.tableAccess.default : null,
        table_access_tables: e.holder.tableAccess ? Object.keys(e.holder.tableAccess.tables).length : 0,
        guardrails: {
          block_unqualified_dml: e.holder.guardrails.blockUnqualifiedDml,
          block_ddl: e.holder.guardrails.blockDdl,
          block_dml: e.holder.guardrails.blockDml,
        },
        approvals: approvalsWire(approvals),
        tenant_scope: tenantScopeIsActive(ts)
          ? { column: ts.defaultColumn, overrides: { ...ts.overrides }, exempt: [...ts.exempt] }
          : null,
        column_masks: masks ? (JSON.parse(JSON.stringify(masks)) as ColumnMasksSpec) : null,
        // The mode actually in force: only meaningful with masks, and the
        // per-DB key wins over the engine-wide default (buildMaskingConfig).
        mask_source_rewrite: masks ? (e.maskSourceRewrite ?? cfg.maskSourceRewrite) : false,
      };
    });
}

// Per-DB summary the swap path hands to finalizeReload. Carries the
// post-swap state plus a coarse diff against the pre-swap state so the
// POLICY_RELOADED audit row is self-describing — operators can verify
// "I changed orders.tenant_id at 14:03" from the audit row alone, no
// dashboard cross-reference required.
interface ReloadSummary {
  name: string;
  tableAccess: TableAccessConfig | undefined;
  tenantScope: TenantScopeSpec;
  guardrails: GuardrailsSpec;
  tableAccessDiff: TableAccessDiff | null;
  tenantScopeDiff: TenantScopeDiff | null;
  guardrailsDiff: GuardrailsDiff | null;
  // Set by the gateway replace path only. The patch path never carried
  // approvals or masks in its reload row, and its rows stay byte-identical.
  approvals?: ApprovalsSpec;
  approvalsDiff?: ApprovalsDiff | null;
  columnMasks?: ColumnMasksSpec | null;
  columnMasksDiff?: ColumnMasksDiff | null;
  // What kind of change happened to this DB. "added" + "rebuilt" both
  // count as DB-level changes regardless of section diffs (the DB
  // itself appearing or having its pool destroyed IS the event), so
  // they always appear in `databases_changed`. "swapped" only counts
  // when a section diff is non-empty — re-sending the same body
  // emits a no-op row.
  kind: "added" | "rebuilt" | "swapped";
}

// Coarse diff: just enough to read the audit row and understand what
// changed. Empty objects/null are omitted by the JSON serializer so a
// no-op swap (re-sending the same body) writes a row that records the
// reload happened but doesn't lie about a change.
interface TableAccessDiff {
  // The default level changed, e.g. "deny" → "read_write".
  default?: { from: TableAccessLevel | null; to: TableAccessLevel };
  // Tables present in `to` but not in `from`.
  tables_added?: Record<string, TableAccessLevel>;
  // Tables present in `from` but not in `to`.
  tables_removed?: Record<string, TableAccessLevel>;
  // Tables in both, but the level changed.
  tables_changed?: Record<string, { from: TableAccessLevel; to: TableAccessLevel }>;
}

// tenant_scope diff (0.5.0 shape). Same "added/removed/changed" pattern as
// table_access. `column` reports a flip of the universal default column;
// `overrides_*` cover per-table column edits (this is what `mappings_*`
// covered pre-0.5.0); `exempt_*` covers the new opt-out list. Empty
// buckets are omitted by the JSON serializer so a single-field flip
// produces a compact payload. The cloud audit dashboard's structured
// diff renderer indexes against this shape.
interface TenantScopeDiff {
  column?: { from: string | null; to: string | null };
  overrides_added?: Record<string, string>;
  overrides_removed?: Record<string, string>;
  overrides_changed?: Record<string, { from: string; to: string }>;
  exempt_added?: string[];
  exempt_removed?: string[];
}

// guardrails diff (0.9.0). Each flag reports a boolean flip; both omitted when
// unchanged, so a no-op swap produces an empty diff (consistent with the other
// sections — an empty diff means "didn't move").
interface GuardrailsDiff {
  block_unqualified_dml?: { from: boolean; to: boolean };
  block_ddl?: { from: boolean; to: boolean };
  block_dml?: { from: boolean; to: boolean };
}

// approvals diff: each write class reports a flip.
interface ApprovalsDiff {
  row_changes?: { from: boolean; to: boolean };
  whole_table_writes?: { from: boolean; to: boolean };
  schema_changes?: { from: boolean; to: boolean };
}

// column_masks diff, keyed "schema.table.column". Rules are listed for adds and
// changes so the row alone says what a column is now masked with.
interface ColumnMasksDiff {
  added?: Record<string, MaskRule>;
  removed?: string[];
  changed?: Record<string, { from: MaskRule; to: MaskRule }>;
}

// Write the POLICY_RELOADED audit row. Best-effort — the swap already
// applied; an audit failure is logged but doesn't roll back.
async function finalizeReload(
  cfg: Config,
  audit: SqliteAuditWriter,
  source: string,
  summaries: ReloadSummary[],
  meta?: { bundleVersion: number },
): Promise<{ applied_at: string }> {
  const appliedAt = new Date().toISOString();
  // The "databases_changed" field on every row in this batch — the names
  // of every DB whose policy actually changed in this swap call. Lets a
  // viewer see "this row is one of N DBs reloaded together" from a single
  // event without joining across rows. A no-op swap (matching mappings
  // re-sent) doesn't list the DB here.
  const databasesChanged = summaries
    .filter((s) => summaryHasChange(s))
    .map((s) => s.name)
    .sort();

  // For multi-DB reloads we emit one POLICY_RELOADED row per affected DB
  // so the audit log carries the per-DB granularity that the column
  // exists for. For legacy single-DB this is just one row keyed on
  // __default__, identical in effect to 0.1.x.
  for (const s of summaries) {
    const sectionsChanged: string[] = [];
    // A section appears in `sections_changed` only when it actually
    // moved — re-sending the same body produces an empty diff and the
    // section is omitted, so consumers can trust the field as a
    // change-feed rather than "what was touched".
    if (diffHasChange(s.tableAccessDiff)) sectionsChanged.push("table_access");
    if (diffHasChange(s.tenantScopeDiff)) sectionsChanged.push("tenant_scope");
    if (diffHasChange(s.guardrailsDiff)) sectionsChanged.push("guardrails");
    if (diffHasChange(s.approvalsDiff ?? null)) sectionsChanged.push("approvals");
    if (diffHasChange(s.columnMasksDiff ?? null)) sectionsChanged.push("column_masks");

    const event: AuditEvent = {
      id: ulid(),
      query_id: ulid(),
      tenant_id: cfg.tenantId,
      database: s.name,
      // POLICY_RELOADED is operator-driven — there's no calling agent,
      // no per-call intent, and no cloud-issued token id (admin endpoint
      // auth is the bearer token, not an X-Midplane-Token-Id). All null.
      agent_name: null,
      agent_version: null,
      agent_intent: null,
      mcp_token_id: null,
      ts: Date.now(),
      schema_version: 3,
      event_type: "POLICY_RELOADED",
      payload: {
        source,
        // Self-describing fields (added in 0.4.0). The cloud audit
        // dashboard indexes against these to render "what changed"
        // without re-fetching adjacent rows. `sections_changed` is the
        // sections that changed for THIS row's DB; `databases_changed`
        // is every DB that changed in this swap call (same value on
        // every row in the batch).
        sections_changed: sectionsChanged,
        databases_changed: databasesChanged,
        // Current full state of each section (kept for backward compat
        // with consumers that read `payload.table_access`).
        table_access: s.tableAccess
          ? { default: s.tableAccess.default, tables: s.tableAccess.tables }
          : null,
        // 0.5.0 shape: { column, overrides, exempt } (replaces the
        // 0.4.x `{ mappings }` blob). `null` when scoping is fully
        // inactive (no column + no overrides) — symmetric with the
        // 0.4.x null-on-empty behavior.
        tenant_scope: tenantScopeIsActive(s.tenantScope)
          ? {
              column: s.tenantScope.defaultColumn,
              overrides: s.tenantScope.overrides,
              exempt: s.tenantScope.exempt,
            }
          : null,
        // Current guardrails posture (0.9.0). Always present — guardrails are
        // never "off"; every flag carries its boolean state.
        guardrails: {
          block_unqualified_dml: s.guardrails.blockUnqualifiedDml,
          block_ddl: s.guardrails.blockDdl,
          block_dml: s.guardrails.blockDml,
        },
        // Coarse diff of what changed for THIS row's DB. `null` for
        // brand-new entries (no prior state to diff against) or sections
        // that weren't touched.
        diff: {
          table_access: s.tableAccessDiff,
          tenant_scope: s.tenantScopeDiff,
          guardrails: s.guardrailsDiff,
          ...(s.approvals !== undefined
            ? { approvals: s.approvalsDiff ?? null, column_masks: s.columnMasksDiff ?? null }
            : {}),
        },
        // Gateway bundles: which signed version this row applied, plus the two
        // sections the patch path never reported, so a bundle row states the
        // whole enforced policy.
        ...(meta ? { bundle_version: meta.bundleVersion } : {}),
        ...(s.approvals !== undefined
          ? {
              approvals: approvalsWire(s.approvals),
              column_masks: s.columnMasks ?? null,
            }
          : {}),
      },
    };
    try {
      await audit.write(event);
    } catch (err) {
      logger.error(
        { err, db: s.name },
        "policy reload applied but audit write failed",
      );
    }
  }

  logger.info(
    {
      databases: summaries.map((s) => ({
        name: s.name,
        tableAccess: s.tableAccess
          ? { default: s.tableAccess.default, tables: Object.keys(s.tableAccess.tables) }
          : null,
      })),
      appliedAt,
      source,
      ...(meta ? { bundleVersion: meta.bundleVersion } : {}),
    },
    source === "bundle" ? "policy bundle applied to engines" : "policy reloaded via admin endpoint",
  );

  return { applied_at: appliedAt };
}

// Should this DB appear in the audit row's `databases_changed` field?
// Adding or rebuilding a DB is itself a DB-level event regardless of
// what's in the policy (a brand-new DB exposes new query surface; a
// URL change destroys + recreates the pool). For "swapped" — pure
// pointer swaps on the same DB — we only count it as a change when at
// least one section's diff is non-empty, so a no-op re-post (operator
// re-sends matching policy) doesn't lie about a change happening.
function summaryHasChange(s: ReloadSummary): boolean {
  if (s.kind === "added" || s.kind === "rebuilt") return true;
  return (
    diffHasChange(s.tableAccessDiff) ||
    diffHasChange(s.tenantScopeDiff) ||
    diffHasChange(s.guardrailsDiff) ||
    diffHasChange(s.approvalsDiff ?? null) ||
    diffHasChange(s.columnMasksDiff ?? null)
  );
}

function diffHasChange(
  diff: TableAccessDiff | TenantScopeDiff | GuardrailsDiff | ApprovalsDiff | ColumnMasksDiff | null,
): boolean {
  if (diff === null) return false;
  for (const key of Object.keys(diff)) {
    const v = (diff as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v === "object" && v !== null && Object.keys(v).length === 0) {
      continue;
    }
    return true;
  }
  return false;
}

// Compute the field-level changes between the prior table_access (may be
// undefined) and the post-swap config. Empty buckets are omitted so the
// JSON payload stays compact when only one thing flipped.
function diffTableAccess(
  prev: TableAccessConfig | undefined,
  next: TableAccessConfig,
): TableAccessDiff {
  const diff: TableAccessDiff = {};
  if (!prev || prev.default !== next.default) {
    diff.default = { from: prev?.default ?? null, to: next.default };
  }
  const prevTables = prev?.tables ?? {};
  const added: Record<string, TableAccessLevel> = {};
  const removed: Record<string, TableAccessLevel> = {};
  const changed: Record<string, { from: TableAccessLevel; to: TableAccessLevel }> = {};
  for (const k of Object.keys(next.tables)) {
    const nextLevel = next.tables[k]!;
    const prevLevel = prevTables[k];
    if (prevLevel === undefined) {
      added[k] = nextLevel;
    } else if (prevLevel !== nextLevel) {
      changed[k] = { from: prevLevel, to: nextLevel };
    }
  }
  for (const k of Object.keys(prevTables)) {
    if (!(k in next.tables)) removed[k] = prevTables[k]!;
  }
  if (Object.keys(added).length > 0) diff.tables_added = added;
  if (Object.keys(removed).length > 0) diff.tables_removed = removed;
  if (Object.keys(changed).length > 0) diff.tables_changed = changed;
  return diff;
}

// Compute the field-level changes between two TenantScopeSpec snapshots.
// Empty buckets are omitted by the JSON serializer so a single-field flip
// stays compact. Symmetric structure with `diffTableAccess` — the cloud
// audit dashboard renderer indexes against the same shape.
function diffTenantScope(
  prev: TenantScopeSpec,
  next: TenantScopeSpec,
): TenantScopeDiff {
  const diff: TenantScopeDiff = {};
  if (prev.defaultColumn !== next.defaultColumn) {
    diff.column = { from: prev.defaultColumn, to: next.defaultColumn };
  }
  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  const changed: Record<string, { from: string; to: string }> = {};
  for (const k of Object.keys(next.overrides)) {
    const nextCol = next.overrides[k]!;
    const prevCol = prev.overrides[k];
    if (prevCol === undefined) added[k] = nextCol;
    else if (prevCol !== nextCol) changed[k] = { from: prevCol, to: nextCol };
  }
  for (const k of Object.keys(prev.overrides)) {
    if (!(k in next.overrides)) removed[k] = prev.overrides[k]!;
  }
  if (Object.keys(added).length > 0) diff.overrides_added = added;
  if (Object.keys(removed).length > 0) diff.overrides_removed = removed;
  if (Object.keys(changed).length > 0) diff.overrides_changed = changed;

  const prevExempt = new Set(prev.exempt);
  const nextExempt = new Set(next.exempt);
  const exemptAdded = next.exempt.filter((t) => !prevExempt.has(t));
  const exemptRemoved = prev.exempt.filter((t) => !nextExempt.has(t));
  if (exemptAdded.length > 0) diff.exempt_added = exemptAdded;
  if (exemptRemoved.length > 0) diff.exempt_removed = exemptRemoved;

  return diff;
}

// Compute the boolean flips between two GuardrailsSpec snapshots. Unchanged
// flags are omitted, so a no-op swap yields an empty diff (which diffHasChange
// reports as "no change", same as the other sections).
function diffGuardrails(
  prev: GuardrailsSpec,
  next: GuardrailsSpec,
): GuardrailsDiff {
  const diff: GuardrailsDiff = {};
  if (prev.blockUnqualifiedDml !== next.blockUnqualifiedDml) {
    diff.block_unqualified_dml = {
      from: prev.blockUnqualifiedDml,
      to: next.blockUnqualifiedDml,
    };
  }
  if (prev.blockDdl !== next.blockDdl) {
    diff.block_ddl = { from: prev.blockDdl, to: next.blockDdl };
  }
  if (prev.blockDml !== next.blockDml) {
    diff.block_dml = { from: prev.blockDml, to: next.blockDml };
  }
  return diff;
}

// The snake_case shape approvals take in audit rows and the heartbeat. `?? false`
// because a holder built from a document with no approvals block may carry an
// empty object.
function approvalsWire(a: ApprovalsSpec): { row_changes: boolean; whole_table_writes: boolean; schema_changes: boolean } {
  return {
    row_changes: a.rowChanges ?? false,
    whole_table_writes: a.wholeTableWrites ?? false,
    schema_changes: a.schemaChanges ?? false,
  };
}

function diffApprovals(prev: ApprovalsSpec, next: ApprovalsSpec): ApprovalsDiff {
  const diff: ApprovalsDiff = {};
  const from = approvalsWire(prev);
  const to = approvalsWire(next);
  for (const k of Object.keys(from) as Array<keyof ApprovalsDiff>) {
    if (from[k] !== to[k]) diff[k] = { from: from[k], to: to[k] };
  }
  return diff;
}

function diffColumnMasks(
  prev: ColumnMasksSpec | null,
  next: ColumnMasksSpec | null,
): ColumnMasksDiff {
  const flat = (m: ColumnMasksSpec | null): Map<string, MaskRule> => {
    const out = new Map<string, MaskRule>();
    for (const [table, cols] of Object.entries(m ?? {})) {
      for (const [col, rule] of Object.entries(cols)) out.set(`${table}.${col}`, rule);
    }
    return out;
  };
  const a = flat(prev);
  const b = flat(next);
  const added: Record<string, MaskRule> = {};
  const changed: Record<string, { from: MaskRule; to: MaskRule }> = {};
  const removed: string[] = [];
  for (const [k, rule] of b) {
    const was = a.get(k);
    if (was === undefined) added[k] = rule;
    else if (!isDeepStrictEqual(was, rule)) changed[k] = { from: was, to: rule };
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  const diff: ColumnMasksDiff = {};
  if (Object.keys(added).length > 0) diff.added = added;
  if (removed.length > 0) diff.removed = removed.sort();
  if (Object.keys(changed).length > 0) diff.changed = changed;
  return diff;
}

// "Is this tenant_scope config actually enforcing anything?" Mirrors the
// engine rule's short-circuit: no defaultColumn AND no overrides means
// every queried table allows. Exempt-only is also inert (nothing to
// exempt from). Used to gate the audit row's `tenant_scope` payload and
// the "added" summary's diff base.
function tenantScopeIsActive(ts: TenantScopeSpec): boolean {
  return ts.defaultColumn !== null || Object.keys(ts.overrides).length > 0;
}

function cloneTenantScope(ts: TenantScopeSpec): TenantScopeSpec {
  return {
    defaultColumn: ts.defaultColumn,
    overrides: { ...ts.overrides },
    exempt: [...ts.exempt],
  };
}

// Crude DSN masking for log lines so the password never lands in logs.
// Strips the userinfo portion of a postgres:// URL.
function maskDsn(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparsable>";
  }
}
