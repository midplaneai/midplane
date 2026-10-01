// Test harness: a throwaway database and a non-superuser role on the Postgres
// named by MIDPLANE_TEST_PG (an admin DSN), and a local gateway in front of it.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadParser } from "@midplane/core";
import pg from "pg";
import { generateSigningKey, mintToken } from "../src/auth.ts";
import { parseConfig } from "../src/config.ts";
import { MCP_PATH } from "../src/http.ts";
import { type RunningGateway, startLocal } from "../src/server.ts";

export const ADMIN_DSN = process.env.MIDPLANE_TEST_PG;
if (!ADMIN_DSN && process.env.CI) {
  throw new Error("MIDPLANE_TEST_PG must name a Postgres admin DSN in CI");
}
export const hasPostgres = ADMIN_DSN !== undefined;

export interface TestDatabase {
  name: string;
  role: string;
  /** DSN for the admin on the test database. */
  adminDsn: string;
  /** DSN for the non-superuser role the gateway connects as. */
  agentDsn: string;
  admin(sql: string, values?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

function withDatabase(
  dsn: string,
  database: string,
  user?: string,
  password?: string,
): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export async function createDatabase(
  setupSql: string,
  grantsSql: (role: string) => string,
): Promise<TestDatabase> {
  if (!ADMIN_DSN) throw new Error("no MIDPLANE_TEST_PG");
  const suffix = randomBytes(4).toString("hex");
  const name = `mp_gw_${suffix}`;
  const role = `mp_agent_${suffix}`;
  const password = randomBytes(12).toString("hex");
  const root = new pg.Client({ connectionString: ADMIN_DSN });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await root.end();

  const adminDsn = withDatabase(ADMIN_DSN, name);
  const pool = new pg.Pool({ connectionString: adminDsn, max: 3 });
  // Dropping the database terminates whatever this pool still holds; an
  // idle client's error then has nowhere to go and fails the whole run.
  pool.on("error", () => {});
  await pool.query(setupSql);
  await pool.query(grantsSql(role));

  return {
    name,
    role,
    adminDsn,
    agentDsn: withDatabase(ADMIN_DSN, name, role, password),
    admin: (sql, values) => pool.query(sql, values),
    async drop() {
      await pool.end();
      const r = new pg.Client({ connectionString: ADMIN_DSN });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.query(`DROP ROLE IF EXISTS ${role}`);
      await r.end();
    },
  };
}

export interface TestGateway extends RunningGateway {
  dir: string;
  mcpUrl: string;
  issuer: string;
  salt: string;
  token(o?: Partial<TokenOptions>): Promise<string>;
}

export interface TokenOptions {
  sub: string;
  databases: Record<string, "read" | "write">;
  grantId: string;
  audience: string;
  issuer: string;
  project: string;
  ttlSeconds: number;
  now: number;
  jti: string;
  privateJwk: Record<string, unknown>;
}

export async function startGateway(
  databases: Record<string, { dsn: string; policy: unknown }>,
  options: {
    maxRows?: number;
    revoked?: string[];
    port?: number;
    publicUrls?: string[];
    allowedHosts?: string[];
  } = {},
): Promise<TestGateway> {
  await loadParser();
  const dir = mkdtempSync(join(tmpdir(), "midplane-gw-"));
  const { privateJwk, publicJwk } = await generateSigningKey();
  writeFileSync(join(dir, "verify-key.json"), JSON.stringify(publicJwk));
  const salt = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = { TEST_SALT: salt };
  const dbYaml: Record<string, unknown> = {};
  for (const [id, db] of Object.entries(databases)) {
    env[`DSN_${id.toUpperCase()}`] = db.dsn;
    dbYaml[id] = { dsn: { env: `DSN_${id.toUpperCase()}` }, policy: db.policy };
  }
  const doc = {
    listen: {
      host: "127.0.0.1",
      port: options.port ?? 0,
      allowed_hosts: options.allowedHosts ?? [],
    },
    ...(options.publicUrls ? { public_urls: options.publicUrls } : {}),
    auth: {
      issuer: "midplane-test",
      public_key_file: "verify-key.json",
      revoked_token_ids: options.revoked ?? [],
    },
    audit: { file: "audit.db" },
    mask_salt: { env: "TEST_SALT" },
    limits: { max_rows: options.maxRows ?? 1000 },
    databases: dbYaml,
  };
  const configPath = join(dir, "midplane.yaml");
  const text = JSON.stringify(doc); // JSON is YAML.
  writeFileSync(configPath, text);
  const running = await startLocal(parseConfig(text, configPath, env));
  const mcpUrl = `${running.url}${MCP_PATH}`;
  const allWrite = Object.fromEntries(
    Object.keys(databases).map((id) => [id, "write" as const]),
  );
  return {
    ...running,
    dir,
    mcpUrl,
    issuer: "midplane-test",
    salt,
    token: (o = {}) =>
      mintToken({
        privateJwk: (o.privateJwk ?? privateJwk) as Parameters<
          typeof mintToken
        >[0]["privateJwk"],
        issuer: o.issuer ?? "midplane-test",
        audience: o.audience ?? mcpUrl,
        project: o.project ?? "local",
        sub: o.sub ?? "agent-user",
        clientId: "test-client",
        grantId: o.grantId ?? `grant-${randomUUID()}`,
        databases: o.databases ?? allWrite,
        ttlSeconds: o.ttlSeconds ?? 300,
        ...(o.now !== undefined ? { now: o.now } : {}),
        ...(o.jti ? { jti: o.jti } : {}),
      }),
  };
}

// ── MCP over raw JSON-RPC (the 2025 handshake) ──────────────────────────────

let nextId = 1;

/** POST one JSON-RPC request; returns the HTTP status and the parsed message. */
export async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  let body: unknown = text;
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  try {
    body = JSON.parse(data ? data.slice(6) : text);
  } catch {
    // leave as text
  }
  return { status: res.status, body, headers: res.headers };
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: {
    columns: string[];
    rows: unknown[][];
    row_count: number | null;
    truncated: boolean;
  };
}

export async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const r = await rpc(url, token, "tools/call", { name, arguments: args });
  if (r.status !== 200)
    throw new Error(
      `tools/call ${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`,
    );
  const body = r.body as { result?: ToolResult; error?: unknown };
  if (!body.result)
    throw new Error(`tools/call ${name}: ${JSON.stringify(body)}`);
  return body.result;
}

export async function query(
  url: string,
  token: string,
  sql: string,
  database?: string,
): Promise<ToolResult> {
  return callTool(url, token, "query", {
    sql,
    ...(database ? { database } : {}),
  });
}
