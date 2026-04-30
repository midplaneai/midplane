// Wires Config → Engine. All SQL execution paths flow through this engine —
// no parallel execute paths exist anywhere else in the server.
//
// Hot-reload: tableAccess is constructed with a getter pointed at a mutable
// holder so POST /admin/policy can swap policy without rebuilding the engine
// (and without dropping the agent's MCP session). The swap is a single
// pointer assignment; queries in flight read the holder once at finalize()
// time so they see either the old or the new config — never half-mixed.

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
import { loadPolicyFile, parsePolicyYaml } from "./config.ts";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

export interface EngineHandle {
  engine: Engine;
  ctxBase: EngineContext;
  // Unwrapped SQLite audit writer — used by the indexer pull routes which
  // need read/delete access. The engine sees the (possibly telemetry-wrapped)
  // version; the routes always go through the underlying SQLite store.
  audit: SqliteAuditWriter;
  // Hot-swap the in-memory table_access config. Parses + validates the YAML
  // text, atomically swaps the holder on success, and writes a synthetic
  // POLICY_RELOADED audit event so operators can see the change in history.
  // Throws on YAML parse / schema errors; the caller (HTTP handler) maps the
  // throw to a 400 response. Original policy stays intact on any throw.
  setPolicy(yamlText: string): Promise<{ applied_at: string }>;
  close(): Promise<void>;
}

export interface BuildEngineOptions {
  // Wraps the constructed audit writer (e.g. with a telemetry tee).
  // Defaults to identity so non-telemetry callers don't need to know.
  wrapAudit?: (w: AuditWriter) => AuditWriter;
  // Executor + credentials overrides for tests. Production callers leave
  // these undefined and get the real PgPoolExecutor + EnvCredentialStore.
  executor?: Executor;
  credentials?: CredentialStore;
}

export function buildEngine(cfg: Config, opts: BuildEngineOptions = {}): EngineHandle {
  const baseAudit = new SqliteAuditWriter(cfg.dbPath);
  const audit = opts.wrapAudit ? opts.wrapAudit(baseAudit) : baseAudit;
  const credentials = opts.credentials ?? new EnvCredentialStore("DATABASE_URL");
  const executor =
    opts.executor ?? new PgPoolExecutor({ databaseUrl: cfg.databaseUrl });

  // Holder pattern: the rule reads `holder.tableAccess` on every evaluation.
  // setPolicy mutates this single field, no locks needed (V8 guarantees
  // atomic-pointer-swap on object property assignment in a single-isolate
  // event loop).
  const holder: { tableAccess: TableAccessConfig | undefined } = {
    tableAccess: undefined,
  };

  let mappings: Record<string, string> = {};
  if (cfg.policyFile) {
    const policy = loadPolicyFile(cfg.policyFile);
    mappings = policy.mappings;
    if (policy.tableAccess) {
      holder.tableAccess = {
        default: policy.tableAccess.default,
        tables: policy.tableAccess.tables,
      };
    }
    logger.info(
      {
        policyFile: cfg.policyFile,
        mappedTables: Object.keys(mappings),
        tableAccess: holder.tableAccess
          ? {
              default: holder.tableAccess.default,
              tables: Object.keys(holder.tableAccess.tables),
            }
          : null,
      },
      "policy file loaded",
    );
  }

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
  });

  const ctxBase: EngineContext = {
    tenant_id: cfg.tenantId,
    agent_identity: null,
    role: "agent_readonly",
    ...(Object.keys(mappings).length > 0
      ? { tenant_scope: { mappings } }
      : {}),
  };

  const setPolicy = async (yamlText: string): Promise<{ applied_at: string }> => {
    // parsePolicyYaml throws on YAML / schema errors — let it propagate so
    // the HTTP handler maps to 400. Holder is only mutated AFTER ALL
    // validation passes, so a rejected payload leaves the previous policy
    // intact in every failure mode below.
    const next = parsePolicyYaml(yamlText, "admin endpoint");

    // Required: body must contain table_access. A bare body (or one with
    // only tenant_scope) would otherwise silently clear the current
    // table_access policy because parsePolicyYaml returns tableAccess: null
    // for absent sections — operationally identical to "deny most things"
    // and a foot-gun for the cloud's save-permissions flow.
    if (!next.hasTableAccess || !next.tableAccess) {
      throw new Error(
        "Policy body is missing the required `table_access` section. " +
          "Hot-swap is supported for table_access only; sending other " +
          "sections alone would clear the current policy.",
      );
    }

    // Reject mapping changes: tenant_scope is read from ctxBase, which is
    // captured at construction. Silently accepting a mapping change would
    // 200 a request the engine never actually applied — the cloud would
    // believe new scoping is in force when it isn't. Restart is the
    // documented escape hatch.
    if (next.hasTenantScope && !sameMappings(next.mappings, mappings)) {
      throw new Error(
        "Policy body changes tenant_scope.mappings, which is not " +
          "hot-swappable in this version. Restart the engine to apply " +
          "mapping changes (table_access changes can still be hot-swapped " +
          "by omitting the tenant_scope section or sending it unchanged).",
      );
    }

    // All checks passed — atomic single-pointer swap.
    holder.tableAccess = {
      default: next.tableAccess.default,
      tables: next.tableAccess.tables,
    };

    const appliedAt = new Date().toISOString();
    const auditEvent: AuditEvent = {
      id: ulid(),
      query_id: ulid(),
      tenant_id: cfg.tenantId,
      agent_identity: null,
      ts: Date.now(),
      schema_version: 1,
      event_type: "POLICY_RELOADED",
      payload: {
        source: "admin_endpoint",
        table_access: holder.tableAccess
          ? {
              default: holder.tableAccess.default,
              tables: holder.tableAccess.tables,
            }
          : null,
      },
    };
    // Best-effort: a swap that succeeded but failed to audit still applied
    // (the rule already reads the new config). Log and move on rather than
    // pretending the swap failed.
    try {
      await audit.write(auditEvent);
    } catch (err) {
      logger.error(
        { err },
        "policy reload applied but audit write failed",
      );
    }

    logger.info(
      {
        tableAccess: holder.tableAccess
          ? {
              default: holder.tableAccess.default,
              tables: Object.keys(holder.tableAccess.tables),
            }
          : null,
        appliedAt,
      },
      "policy reloaded via admin endpoint",
    );

    return { applied_at: appliedAt };
  };

  return {
    engine,
    ctxBase,
    audit: baseAudit,
    setPolicy,
    async close() {
      // PgPoolExecutor exposes close(); test mocks (Executor-only) don't.
      const maybeClose = (executor as { close?: () => Promise<void> }).close;
      if (typeof maybeClose === "function") await maybeClose.call(executor);
      // audit may be a wrapper (e.g. telemetry tee); its close() delegates
      // to the inner SqliteAuditWriter. Calling baseAudit.close() here
      // would double-close.
      await audit.close();
    },
  };
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
