// Env-var → typed Config. Schema-validated via zod; refuse to boot on invalid.
//
// Honored: DATABASE_URL, PORT, DB_PATH, MIDPLANE_TENANT_ID,
// MIDPLANE_POLICY_FILE, MIDPLANE_TRANSPORT, INDEXER_TOKEN.
//
// loadPolicyFile reads + parses a YAML override file. The MCP server
// consumes the tenant_scope mappings and the table_access config; the
// four policy rules are hardcoded.

import { z } from "zod";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export const TransportSchema = z.enum(["stdio", "http"]);
export type Transport = z.infer<typeof TransportSchema>;

export const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
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

const PolicyFileSchema = z.object({
  tenant_scope: z
    .object({
      enabled: z.boolean().default(true),
      mappings: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  table_access: z
    .object({
      default: TableAccessLevelSchema.default("read"),
      tables: z.record(z.string(), TableAccessLevelSchema).default({}),
    })
    .optional(),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export type TableAccessLevel = z.infer<typeof TableAccessLevelSchema>;

export interface LoadedPolicy {
  mappings: Record<string, string>;
  tableAccess: {
    default: TableAccessLevel;
    tables: Record<string, TableAccessLevel>;
  } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.DATABASE_URL || env.DATABASE_URL.length === 0) {
    throw new Error(
      "Configuration error: DATABASE_URL is required. " +
        "Set it to a Postgres DSN, e.g. postgres://user:pass@host:5432/db",
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

  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    throw new Error(
      `Policy file YAML parse error at ${path}: ${(err as Error).message}`,
    );
  }

  if (doc === null || doc === undefined) {
    return { mappings: {}, tableAccess: null };
  }

  const parsed = PolicyFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Policy file schema error at ${path}: ${formatZodIssues(parsed.error.issues)}`,
    );
  }

  const ts = parsed.data.tenant_scope;
  const mappings = ts && ts.enabled !== false ? ts.mappings : {};

  const ta = parsed.data.table_access;
  const tableAccess = ta
    ? { default: ta.default, tables: ta.tables }
    : null;

  return { mappings, tableAccess };
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
