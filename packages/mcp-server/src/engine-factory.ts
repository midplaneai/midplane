// Wires Config → Engine. All SQL execution paths flow through this engine —
// no parallel execute paths exist anywhere else in the server.

import {
  Engine,
  EnvCredentialStore,
  SqliteAuditWriter,
  parseError,
  multiStatement,
  writesRequireApproval,
  tenantScope,
  type EngineContext,
} from "@midplane/engine";
import { PgPoolExecutor } from "./executor/pg-pool.ts";
import { loadPolicyFile } from "./config.ts";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

export interface EngineHandle {
  engine: Engine;
  ctxBase: EngineContext;
  close(): Promise<void>;
}

export function buildEngine(cfg: Config): EngineHandle {
  const audit = new SqliteAuditWriter(cfg.dbPath);
  const credentials = new EnvCredentialStore("DATABASE_URL");
  const executor = new PgPoolExecutor({ databaseUrl: cfg.databaseUrl });

  const engine = new Engine({
    policy: {
      rules: [parseError(), multiStatement(), writesRequireApproval(), tenantScope()],
    },
    audit,
    credentials,
    executor,
  });

  let mappings: Record<string, string> = {};
  if (cfg.policyFile) {
    const policy = loadPolicyFile(cfg.policyFile);
    mappings = policy.mappings;
    logger.info(
      { policyFile: cfg.policyFile, mappedTables: Object.keys(mappings) },
      "policy file loaded",
    );
  }

  const ctxBase: EngineContext = {
    tenant_id: cfg.tenantId,
    agent_identity: null,
    role: "agent_readonly",
    ...(Object.keys(mappings).length > 0
      ? { tenant_scope: { mappings } }
      : {}),
  };

  return {
    engine,
    ctxBase,
    async close() {
      await executor.close();
      await audit.close();
    },
  };
}
