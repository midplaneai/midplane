// Wires Config + LoadedPolicy → EngineRegistry. All SQL execution paths
// flow through this registry — no parallel execute paths exist anywhere
// else in the server.
//
// Single-DB callers see a registry containing one Engine named
// '__default__' (the legacy synthetic name). Multi-DB callers see one
// Engine per `databases:` entry. The MCP layer queries `count` /
// `databaseNames` to reshape its tool surface.
//
// Hot-reload: each Engine carries its own table_access holder (pointer
// swap on policy reload, identical to 0.1.x). The registry exposes a
// single `setPolicy(yamlText)` entrypoint that handles both shapes:
// the legacy single-DB body re-routes to engines.get('__default__'); the
// multi-DB shape diffs `databases[]` and adds/removes/updates engines as
// needed.

import { ulid } from "ulid";
import {
  Engine,
  EnvCredentialStore,
  SqliteAuditWriter,
  parseError,
  multiStatement,
  tableAccess,
  tenantScope,
  type AuditEvent,
  type AuditWriter,
  type CredentialStore,
  type EngineContext,
  type Executor,
  type TableAccessConfig,
} from "@midplane/engine";
import { PgPoolExecutor } from "./executor/pg-pool.ts";
import {
  DEFAULT_DB_NAME,
  loadPolicyFile,
  parsePolicyYaml,
  resolveDatabasesFromConfig,
  type DatabaseSpec,
  type LoadedPolicy,
  type TableAccessLevel,
} from "./config.ts";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

// What the MCP layer holds per registered DB.
interface EngineEntry {
  name: string;
  engine: Engine;
  ctxBase: EngineContext;
  // Pointer swap target for table_access reloads. Same pattern as 0.1.x.
  holder: { tableAccess: TableAccessConfig | undefined };
  // Captured at construction; mappings can't be hot-swapped (same rule as
  // 0.1.x — engine.ctxBase is captured at construction).
  mappings: Record<string, string>;
  // Owning executor so the registry can close the pool when the entry is
  // dropped. Tests inject a stub Executor that may not have close().
  executor: Executor;
  // The DSN this engine is bound to. Used by the hot-reload path to detect
  // url changes (which require a pool rebuild) versus pure policy edits.
  url: string;
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
  // EngineEntry internals.
  describe(): Array<{
    name: string;
    tenant_scope_enabled: boolean;
    table_access_default: TableAccessLevel | null;
  }>;
  // Hot-swap entrypoint. Same body as 0.1.x's setPolicy — the registry
  // dispatches based on shape (legacy → swap on __default__; multi-DB →
  // diff and reconcile).
  setPolicy(yamlText: string): Promise<{ applied_at: string }>;
  close(): Promise<void>;
}

export interface EngineHandle {
  registry: EngineRegistry;
  close(): Promise<void>;
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
}

export function buildEngine(cfg: Config, opts: BuildEngineOptions = {}): EngineHandle {
  // ── 1. Load YAML (if any) and resolve to a DatabaseSpec[] ─────────────
  let policy: LoadedPolicy;
  if (cfg.policyFile) {
    policy = loadPolicyFile(cfg.policyFile);
  } else {
    // No YAML → synthetic legacy shape with a single default DB.
    policy = {
      databases: [
        {
          name: DEFAULT_DB_NAME,
          url: "",
          mappings: {},
          hasTenantScope: false,
          tableAccess: null,
          hasTableAccess: false,
        },
      ],
      hasDatabasesBlock: false,
      mappings: {},
      tableAccess: null,
      hasTenantScope: false,
      hasTableAccess: false,
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
          mappedTables: Object.keys(s.mappings),
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

    // Legacy single-DB shape. Same validation rules as 0.1.x: body MUST
    // contain table_access, mappings can't change.
    if (!next.hasTableAccess || !next.tableAccess) {
      throw new Error(
        "Policy body is missing the required `table_access` section. " +
          "Hot-swap is supported for table_access only; sending other " +
          "sections alone would clear the current policy.",
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
    // Same mappings-change rejection as 0.1.x: only enforced when the
    // body explicitly carries `tenant_scope`. Omitted = "don't touch",
    // so we don't compare against the empty default in that case.
    if (next.hasTenantScope && !sameMappings(next.mappings, target.mappings)) {
      throw new Error(
        "Policy body changes tenant_scope.mappings, which is not " +
          "hot-swappable in this version. Restart the engine to apply " +
          "mapping changes (table_access changes can still be hot-swapped " +
          "by omitting the tenant_scope section or sending it unchanged).",
      );
    }
    target.holder.tableAccess = {
      default: next.tableAccess.default,
      tables: next.tableAccess.tables,
    };
    return finalizeReload(
      cfg,
      baseAudit,
      "admin_endpoint",
      [{ name: target.name, tableAccess: target.holder.tableAccess }],
    );
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
        .map((e) => ({
          name: e.name,
          tenant_scope_enabled: Object.keys(e.mappings).length > 0,
          table_access_default: e.holder.tableAccess
            ? e.holder.tableAccess.default
            : null,
        }));
    },
    setPolicy,
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
    async close() {
      await registry.close();
    },
  };
}

// Build an EngineEntry from a single resolved DatabaseSpec. Used both at
// boot and by the hot-reload path when adding a previously-unseen DB.
function makeEngineEntry(
  spec: DatabaseSpec,
  cfg: Config,
  audit: AuditWriter,
  credentials: CredentialStore,
  opts: BuildEngineOptions,
): EngineEntry {
  const holder: { tableAccess: TableAccessConfig | undefined } = {
    tableAccess: spec.tableAccess
      ? { default: spec.tableAccess.default, tables: spec.tableAccess.tables }
      : undefined,
  };

  // Tests inject one shared executor across DBs (for back-compat with
  // single-engine tests). Production gets one pool per DB.
  const executor =
    opts.executor ??
    new PgPoolExecutor({ databaseUrl: spec.url });

  const engine = new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(() => holder.tableAccess),
        tenantScope(),
      ],
    },
    audit,
    credentials,
    executor,
    databaseName: spec.name,
  });

  const ctxBase: EngineContext = {
    tenant_id: cfg.tenantId,
    agent_identity: null,
    role: "agent_readonly",
    ...(Object.keys(spec.mappings).length > 0
      ? { tenant_scope: { mappings: spec.mappings } }
      : {}),
  };

  return {
    name: spec.name,
    engine,
    ctxBase,
    holder,
    mappings: spec.mappings,
    executor,
    url: spec.url,
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

    // Mappings change rejection per-DB. Only enforced for entries that
    // already exist AND whose body explicitly carries `tenant_scope`.
    // Omitted = "don't touch" (matches the legacy single-DB hot-reload
    // semantics) — without this gate, a body that only tweaks
    // table_access would falsely register as a mappings change because
    // s.mappings normalizes to {} when the section is absent.
    if (existing && s.hasTenantScope && !sameMappings(s.mappings, existing.mappings)) {
      throw new Error(
        `Hot-swap of databases[name=${s.name}].tenant_scope.mappings is not supported in this version. Restart the engine to apply mapping changes.`,
      );
    }

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

  const summaries: Array<{ name: string; tableAccess: TableAccessConfig | undefined }> = [];
  const toRemove = new Set(entries.keys());

  for (const spec of specs) {
    toRemove.delete(spec.name);
    const existing = entries.get(spec.name);
    if (!existing) {
      const fresh = makeEngineEntry(spec, cfg, audit, credentials, opts);
      entries.set(spec.name, fresh);
      logger.info({ db: spec.name }, "hot reload added database");
      summaries.push({ name: spec.name, tableAccess: fresh.holder.tableAccess });
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
      const maybeClose = (existing.executor as { close?: () => Promise<void> }).close;
      if (typeof maybeClose === "function") {
        await maybeClose.call(existing.executor).catch((err) => {
          logger.warn({ err, db: spec.name }, "executor close on url change failed");
        });
      }
      const fresh = makeEngineEntry(spec, cfg, audit, credentials, opts);
      entries.set(spec.name, fresh);
      summaries.push({ name: spec.name, tableAccess: fresh.holder.tableAccess });
      continue;
    }

    // Same url — in-place table_access swap. Pointer swap on the holder.
    existing.holder.tableAccess = spec.tableAccess
      ? { default: spec.tableAccess.default, tables: spec.tableAccess.tables }
      : undefined;
    summaries.push({ name: spec.name, tableAccess: existing.holder.tableAccess });
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

// Write the POLICY_RELOADED audit row. Best-effort — the swap already
// applied; an audit failure is logged but doesn't roll back.
async function finalizeReload(
  cfg: Config,
  audit: SqliteAuditWriter,
  source: string,
  summaries: Array<{ name: string; tableAccess: TableAccessConfig | undefined }>,
): Promise<{ applied_at: string }> {
  const appliedAt = new Date().toISOString();

  // For multi-DB reloads we emit one POLICY_RELOADED row per affected DB
  // so the audit log carries the per-DB granularity that the column
  // exists for. For legacy single-DB this is just one row keyed on
  // __default__, identical in effect to 0.1.x.
  for (const s of summaries) {
    const event: AuditEvent = {
      id: ulid(),
      query_id: ulid(),
      tenant_id: cfg.tenantId,
      database: s.name,
      agent_identity: null,
      ts: Date.now(),
      schema_version: 1,
      event_type: "POLICY_RELOADED",
      payload: {
        source,
        table_access: s.tableAccess
          ? { default: s.tableAccess.default, tables: s.tableAccess.tables }
          : null,
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
    },
    "policy reloaded via admin endpoint",
  );

  return { applied_at: appliedAt };
}

// Order-independent map equality. JSON.stringify would false-diff on key
// order, and the cloud has no reason to preserve YAML key ordering across
// saves.
function sameMappings(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
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
