// Approvals across a policy hot-reload, through the REAL buildEngine.
//
// This exists because of a bug it would have caught. The engine reads its
// approvals config through a getter so a toggle takes effect on the next
// statement, but the factory's hot-swap only copied the fields it had been
// taught about — and approvals was not one of them. The engine tests passed
// (the getter worked), yet a policy push turning approvals ON would land in the
// control plane and never reach a warm container: writes would keep executing
// unapproved until the next respawn.
//
// So the assertion here is deliberately end-of-chain — not "the holder was
// updated" but "the gate is now consulted, and it was not before".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalGate, ApprovalOutcome, ApprovalRequest } from "@midplane/engine";
import { buildEngine, type EngineHandle } from "../src/engine-factory.ts";
import { buildServer } from "../src/server.ts";
import { MockExecutor } from "./_helpers.ts";

class CountingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(req);
    return { status: "approved", by: "dustin@example.com", note: null };
  }
}

const CTX = {
  tenant_id: "__self_host__",
  agent_name: "test",
  agent_version: "1",
  mcp_token_id: null,
};

const WRITE = "UPDATE orders SET status='x' WHERE id=1";

function policyYaml(approvals: boolean | null): string {
  const lines = [
    "databases:",
    "  - name: main",
    "    url: postgres://stub",
    "    table_access:",
    "      default: read_write",
    "      tables: {}",
  ];
  if (approvals !== null) {
    lines.push("    approvals:", `      writes: ${approvals}`);
  }
  return lines.join("\n") + "\n";
}

describe("approvals across a hot-reload", () => {
  let dir: string;
  let handle: EngineHandle;
  let gate: CountingGate;
  let executor: MockExecutor;

  function build(initial: string): EngineHandle {
    const policyFile = join(dir, "policy.yaml");
    writeFileSync(policyFile, initial);
    return buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        policyFile,
        transport: "http",
      },
      {
        executor,
        credentials: { resolve: async () => "postgres://stub" },
        approvalGate: gate,
      },
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-approvals-reload-"));
    gate = new CountingGate();
    executor = new MockExecutor();
  });

  afterEach(async () => {
    await handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("turning approvals ON reaches a warm engine", async () => {
    handle = build(policyYaml(false));
    const engine = () => handle.registry.get("main").engine;

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(0);

    // The hot-reload the control plane performs when someone flips the toggle.
    await handle.registry.setPolicy(policyYaml(true));

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(1);
  });

  test("turning approvals OFF also reaches a warm engine", async () => {
    handle = build(policyYaml(true));
    const engine = () => handle.registry.get("main").engine;

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(1);

    await handle.registry.setPolicy(policyYaml(false));

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(1);
  });

  test("a reload that omits the section leaves approvals untouched", async () => {
    // Omit-vs-set: a body editing table_access alone must not silently switch
    // approvals off. Same rule guardrails already follows.
    handle = build(policyYaml(true));
    const engine = () => handle.registry.get("main").engine;

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(1);

    await handle.registry.setPolicy(policyYaml(null));

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(2);
  });

  test("the legacy single-DB shape hot-reloads approvals too", async () => {
    // Self-host and pre-multi-DB YAML take a different swap branch inside the
    // factory. It is easy to fix one branch and believe both work — the
    // multi-DB tests above stayed green while this path was still broken.
    const legacy = (approvals: boolean) =>
      [
        "table_access:",
        "  default: read_write",
        "  tables: {}",
        "approvals:",
        `  writes: ${approvals}`,
        "",
      ].join("\n");

    handle = build(legacy(false));
    const engine = () => handle.registry.get("__default__").engine;

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(0);

    await handle.registry.setPolicy(legacy(true));

    await engine().handle({ sql: WRITE, ctx: CTX });
    expect(gate.seen).toHaveLength(1);
  });
});

describe("check_approval tool surface", () => {
  // Regression: this tool was registered inline in the multi-DB tail of
  // buildServer, and the SINGLE-DB branch returns its own server well before
  // reaching that code. Single-database projects — most of them — saw three
  // tools and no way to check an approval. Nothing caught it, because the only
  // assertions were on the gate, never on the tool LIST.
  function toolNames(server: unknown): string[] {
    // The SDK keeps registered tools on an internal map; read it rather than
    // driving a full MCP session, which would need a transport per case.
    const reg = (server as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    return Object.keys(reg ?? {}).sort();
  }

  const gate = {
    async request() {
      throw new Error("unused");
    },
    async check() {
      return { status: "expired" as const };
    },
  };

  test("a single-database project gets it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-tools-single-"));
    const handle = buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath: join(dir, "a.db"),
        tenantId: "__self_host__",
        transport: "http",
      },
      { executor: new MockExecutor(), credentials: { resolve: async () => "postgres://stub" } },
    );
    try {
      const names = toolNames(buildServer({ handle, approvalGate: gate }));
      expect(names).toContain("check_approval");
      expect(names).toContain("query");
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no gate ⇒ the tool is not advertised", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-tools-nogate-"));
    const handle = buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath: join(dir, "b.db"),
        tenantId: "__self_host__",
        transport: "http",
      },
      { executor: new MockExecutor(), credentials: { resolve: async () => "postgres://stub" } },
    );
    try {
      // A deployment without approvals must not offer a tool that always fails.
      expect(toolNames(buildServer({ handle }))).not.toContain("check_approval");
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
