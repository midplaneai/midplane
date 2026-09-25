// Regression pins for the non-gateway callers of code the gateway work touched:
// the hosted approval gate's static bearer (now built by a shared helper, on
// the status call too), and the admin hot-reload's POLICY_RELOADED row, which
// shares finalizeReload with the bundle path and must stay byte-identical.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpApprovalGate } from "../../src/approval-gate.ts";
import { buildEngine, type BuiltEngineHandle } from "../../src/engine-factory.ts";
import { MockExecutor } from "../_helpers.ts";

const PATCH_V1 = `databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: read
    guardrails:
      block_ddl: true
`;

const PATCH_V2 = `databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables:
        users: read
    guardrails:
      block_ddl: false
`;

describe("existing callers are unchanged by the gateway work", () => {
  let dir: string;
  let handle: BuiltEngineHandle | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-gw-regress-"));
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the hosted gate's status call carries the static bearer; the admin reload row carries no bundle fields", async () => {
    // 1. Static-token gate: check() posts to /status with the same bearer as request().
    const seen: Array<{ url: string; auth: string; body: string }> = [];
    const gate = new HttpApprovalGate(
      { url: "https://app.midplane.test/api/engine/approvals", token: "secret-token" },
      (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: init.body as string });
        return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    expect(await gate.check("apr_1", "tok_a")).toEqual({ status: "expired" });
    expect(seen).toEqual([
      {
        url: "https://app.midplane.test/api/engine/approvals/status",
        auth: "Bearer secret-token",
        body: JSON.stringify({ approval_id: "apr_1", mcp_token_id: "tok_a" }),
      },
    ]);

    // 2. Admin (patch) reload: same payload shape as before the replace path
    //    started sharing finalizeReload — no bundle_version, approvals or
    //    column_masks keys, and a three-section diff.
    const policyFile = join(dir, "policy.yaml");
    writeFileSync(policyFile, PATCH_V1);
    handle = buildEngine(
      { port: 0, host: "127.0.0.1", dbPath: join(dir, "audit.db"), tenantId: "__self_host__", policyFile, transport: "http", maskSourceRewrite: false },
      { executor: new MockExecutor(), credentials: { resolve: async () => "postgres://stub" } },
    );
    await handle.registry.setPolicy(PATCH_V2);
    const row = handle.registry.audit
      .readSince("0", 100)
      .filter((r) => r.event_type === "POLICY_RELOADED")
      .at(-1)!;
    const payload = row.payload as Record<string, unknown>;
    expect(payload.source).toBe("admin_endpoint");
    expect(payload).not.toHaveProperty("bundle_version");
    expect(payload).not.toHaveProperty("approvals");
    expect(payload).not.toHaveProperty("column_masks");
    expect(Object.keys(payload.diff as object).sort()).toEqual(["guardrails", "table_access", "tenant_scope"]);
    expect((payload.sections_changed as string[]).sort()).toEqual(["guardrails", "table_access"]);
  });
});
