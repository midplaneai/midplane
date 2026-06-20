// previewQuery + parseQueryToolResult — the masked-preview execution path.
//
// previewQuery acquires a container and drives the agent's `query` tool, so
// the load-bearing behaviors here are: it sends `database` ONLY on the multi-DB
// surface; it maps the tool's {allowed:true|false} JSON into the typed outcome;
// it caps the rows handed back; and it fails closed (engine_unavailable +
// invalidate) when the MCP call throws. The MCP driver is stubbed so this runs
// without a live engine; parseQueryToolResult is exercised directly.

import { describe, expect, it, vi } from "vitest";

import {
  parseQueryToolResult,
  previewQuery,
  type CallQueryToolArgs,
  type RawToolResult,
} from "../src/preview.ts";
import type { ContainerRegistry, SpawnOptions } from "../src/spawner.ts";

const DB = {
  name: "main",
  projectDatabaseId: "01HXYZMAIN0000000000000000",
  dsn: "postgres://x",
  tableAccess: { default: "read" as const, tables: {} },
  tenantScope: { column: null, overrides: {}, exempt: [] },
  guardrails: { block_unqualified_dml: true, block_ddl: true },
  columnMasks: { "public.users": { email: "full-redact" as const } },
};

function spawn(databases = [DB]): SpawnOptions {
  return {
    projectId: "01HXYZCNN000000000000000AA",
    region: "eu",
    databases,
    maskSalt: "deadbeef",
  };
}

function makeRegistry(opts: { failSpawn?: boolean } = {}) {
  const invalidate = vi.fn(async () => undefined);
  const registry = {
    async acquire(_s: SpawnOptions) {
      if (opts.failSpawn) throw new Error("fly capacity");
      return { host: "127.0.0.1", port: 31000 };
    },
    invalidate,
  };
  return { registry: registry as unknown as ContainerRegistry, invalidate };
}

const req = { database: "main", sql: "select email from users", intent: "preview", rowLimit: 25 };

describe("parseQueryToolResult", () => {
  it("maps an ALLOW result to masked rows, capped at rowLimit", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ email: "***", i }));
    const raw: RawToolResult = {
      text: JSON.stringify({ allowed: true, rows, rowCount: 5, auditId: "aud1" }),
      isError: false,
    };
    const out = parseQueryToolResult(raw, 3);
    expect(out).toMatchObject({ ok: true, kind: "rows", rowCount: 5, truncated: true, auditId: "aud1" });
    if (out.ok && out.kind === "rows") expect(out.rows).toHaveLength(3);
  });

  it("does not flag truncated when rows fit under the limit", () => {
    const raw: RawToolResult = {
      text: JSON.stringify({ allowed: true, rows: [{ email: "***" }], rowCount: 1 }),
      isError: false,
    };
    const out = parseQueryToolResult(raw, 25);
    expect(out).toMatchObject({ ok: true, kind: "rows", truncated: false, auditId: null });
  });

  it("maps a column_masking DENY to a structured rejection", () => {
    const raw: RawToolResult = {
      text: JSON.stringify({
        allowed: false,
        policy_rule: "column_masking",
        reason: "query rejected: column \"email\" comes from a view; query the base table",
        auditId: "aud2",
      }),
      isError: true,
    };
    const out = parseQueryToolResult(raw, 25);
    expect(out).toEqual({
      ok: true,
      kind: "rejected",
      policyRule: "column_masking",
      reason: 'query rejected: column "email" comes from a view; query the base table',
      auditId: "aud2",
    });
  });

  it("maps an ordinary policy DENY (table_access) to a rejection", () => {
    const raw: RawToolResult = {
      text: JSON.stringify({ allowed: false, policy_rule: "table_access", reason: "denied" }),
      isError: true,
    };
    const out = parseQueryToolResult(raw, 25);
    expect(out).toMatchObject({ ok: true, kind: "rejected", policyRule: "table_access" });
  });

  it("treats unparseable JSON as engine_unavailable", () => {
    const out = parseQueryToolResult({ text: "not json", isError: false }, 25);
    expect(out).toMatchObject({ ok: false, kind: "engine_unavailable" });
  });

  it("treats an unexpected shape as engine_unavailable", () => {
    const out = parseQueryToolResult({ text: JSON.stringify({ hello: 1 }), isError: false }, 25);
    expect(out).toMatchObject({ ok: false, kind: "engine_unavailable" });
  });
});

describe("previewQuery", () => {
  it("returns engine_unavailable when the spawn fails", async () => {
    const { registry } = makeRegistry({ failSpawn: true });
    const out = await previewQuery(spawn(), req, { registry });
    expect(out).toMatchObject({ ok: false, kind: "engine_unavailable" });
  });

  it("omits `database` on the single-DB surface", async () => {
    const { registry } = makeRegistry();
    let seen: CallQueryToolArgs | undefined;
    const callQueryTool = vi.fn(async (a: CallQueryToolArgs) => {
      seen = a;
      return { text: JSON.stringify({ allowed: true, rows: [], rowCount: 0 }), isError: false };
    });
    const out = await previewQuery(spawn(), req, { registry, callQueryTool });
    expect(out).toMatchObject({ ok: true, kind: "rows" });
    expect(seen?.database).toBeUndefined();
    expect(seen?.url).toBe("http://127.0.0.1:31000/mcp");
  });

  it("sends `database` on the multi-DB surface", async () => {
    const second = { ...DB, name: "analytics", projectDatabaseId: "01HXYZANALYTICS00000000000" };
    const { registry } = makeRegistry();
    let seen: CallQueryToolArgs | undefined;
    const callQueryTool = vi.fn(async (a: CallQueryToolArgs) => {
      seen = a;
      return { text: JSON.stringify({ allowed: true, rows: [], rowCount: 0 }), isError: false };
    });
    await previewQuery(spawn([DB, second]), req, { registry, callQueryTool });
    expect(seen?.database).toBe("main");
  });

  it("invalidates the container and returns engine_unavailable when the call throws", async () => {
    const { registry, invalidate } = makeRegistry();
    const callQueryTool = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const out = await previewQuery(spawn(), req, { registry, callQueryTool });
    expect(out).toMatchObject({ ok: false, kind: "engine_unavailable" });
    expect(invalidate).toHaveBeenCalledWith("01HXYZCNN000000000000000AA");
  });
});
