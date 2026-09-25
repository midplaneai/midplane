// Mask hot-swap against a real Postgres: masks added, removed and re-added by
// successive bundles reach the SAME agent session without a restart, through
// the source-rewrite path the control plane turns on for every masked database.
//
// Gated on MASKING_LIVE_PG_DSN (the same variable as the engine's source-rewrite
// live harness) so the plain `bun test` job skips it. Run with:
//   MASKING_LIVE_PG_DSN=postgres://postgres@127.0.0.1:5432/probe \
//     bun test packages/mcp-server/test/gateway/replace-masks.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { buildEngine, type BuiltEngineHandle } from "../../src/engine-factory.ts";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";
import { buildServer } from "../../src/server.ts";

const DSN = process.env.MASKING_LIVE_PG_DSN;
const d = DSN ? describe : describe.skip;

const ENV = "MIDPLANE_DSN_01LIVEAAAAAAAAAAAAAAAAAAAA";
const RAW_EMAIL = "ada@example.com";

function policy(masked: boolean): string {
  const lines = [
    "databases:",
    "  - name: main",
    `    url: \${${ENV}}`,
    "    table_access:",
    "      default: read",
    "      tables: {}",
    "    guardrails:",
    "      block_unqualified_dml: true",
    "      block_ddl: true",
  ];
  if (masked) {
    lines.push(
      "    requires_features:",
      "      - column_masks",
      "      - mask_source_rewrite",
      "    mask_source_rewrite: true",
      "    column_masks:",
      "      gw_live.users:",
      "        email: full-redact",
    );
  }
  return lines.join("\n") + "\n";
}

d("gateway mask hot-swap (live Postgres)", () => {
  let dir: string;
  let handle: BuiltEngineHandle;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DSN });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS gw_live CASCADE");
    await admin.query("CREATE SCHEMA gw_live");
    await admin.query("CREATE TABLE gw_live.users (id int PRIMARY KEY, email text NOT NULL)");
    await admin.query("INSERT INTO gw_live.users VALUES (1, $1)", [RAW_EMAIL]);

    dir = mkdtempSync(join(tmpdir(), "midplane-replace-live-"));
    handle = buildEngine(
      {
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        transport: "http",
        maskSalt: "s".repeat(32),
        maskSourceRewrite: false,
      },
      { startEmpty: true },
    );
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.query("DROP SCHEMA IF EXISTS gw_live CASCADE");
    await admin?.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function apply(masked: boolean, version: number) {
    const checked = checkBundlePolicy(policy(masked));
    if (!checked.ok) throw new Error(checked.reason);
    await handle.replacePolicy(
      checked.databases.map((db) => ({ spec: { ...db.spec, url: DSN! }, dsnEnv: db.dsnEnv, configured: true })),
      { bundleVersion: version },
    );
  }

  test("masked → unmasked → masked on one session", async () => {
    await apply(true, 1);
    const server = buildServer({ handle });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })
      ._registeredTools;
    const email = async (): Promise<unknown> => {
      const res = (await tools.query!.handler({ sql: "SELECT email FROM gw_live.users WHERE id = 1", intent: "live" })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      if (res.isError) throw new Error(res.content[0]!.text);
      return (JSON.parse(res.content[0]!.text) as { rows: Array<{ email: unknown }> }).rows[0]!.email;
    };

    const masked = await email();
    expect(masked).not.toBe(RAW_EMAIL);

    await apply(false, 2);
    expect(await email()).toBe(RAW_EMAIL);

    await apply(true, 3);
    expect(await email()).toBe(masked);
  });
});
