// Config schema tests.
//
// Brief: missing DATABASE_URL fails fast; unknown MIDPLANE_TRANSPORT fails;
// policy-file YAML parse errors fail.

import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadPolicyFile } from "../src/config.ts";

describe("loadConfig", () => {
  test("missing DATABASE_URL throws", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  test("minimal valid env populates defaults", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x" });
    expect(cfg.databaseUrl).toBe("postgres://x");
    expect(cfg.port).toBe(8080);
    expect(cfg.dbPath).toBe("/data/audit.db");
    expect(cfg.tenantId).toBe("__self_host__");
    expect(cfg.transport).toBe("http");
    expect(cfg.policyFile).toBeUndefined();
  });

  test("PORT coerces from string and validates range", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", PORT: "3000" }).port).toBe(3000);
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", PORT: "70000" }),
    ).toThrow();
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", PORT: "not-a-number" }),
    ).toThrow();
  });

  test("unknown MIDPLANE_TRANSPORT fails", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", MIDPLANE_TRANSPORT: "websocket" }),
    ).toThrow(/MIDPLANE_TRANSPORT|transport/i);
  });

  test("MIDPLANE_TRANSPORT=stdio is accepted", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      MIDPLANE_TRANSPORT: "stdio",
    });
    expect(cfg.transport).toBe("stdio");
  });

  test("MIDPLANE_TENANT_ID overrides default", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      MIDPLANE_TENANT_ID: "42",
    });
    expect(cfg.tenantId).toBe("42");
  });

  test("DB_PATH and PORT and MIDPLANE_POLICY_FILE pass through", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      DB_PATH: "/tmp/audit.db",
      PORT: "9000",
      MIDPLANE_POLICY_FILE: "/etc/midplane/policy.yaml",
    });
    expect(cfg.dbPath).toBe("/tmp/audit.db");
    expect(cfg.port).toBe(9000);
    expect(cfg.policyFile).toBe("/etc/midplane/policy.yaml");
  });

  test("INDEXER_TOKEN is undefined by default and passes through when set", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).indexerToken).toBeUndefined();
    const cfg = loadConfig({
      DATABASE_URL: "postgres://x",
      INDEXER_TOKEN: "tok-abc",
    });
    expect(cfg.indexerToken).toBe("tok-abc");
  });
});

describe("loadPolicyFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-cfg-"));

  test("valid YAML with tenant_scope mappings parses", () => {
    const path = join(dir, "ok.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: true
  mappings:
    users: org_id
    posts: org_id
`,
    );
    const policy = loadPolicyFile(path);
    expect(policy.mappings).toEqual({ users: "org_id", posts: "org_id" });
  });

  test("YAML parse error throws", () => {
    const path = join(dir, "bad.yaml");
    writeFileSync(path, "tenant_scope: {{not yaml");
    expect(() => loadPolicyFile(path)).toThrow();
  });

  test("schema mismatch throws (mappings must be string→string)", () => {
    const path = join(dir, "schema-mismatch.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: true
  mappings:
    users: 42
`,
    );
    expect(() => loadPolicyFile(path)).toThrow();
  });

  test("missing tenant_scope returns empty mappings", () => {
    const path = join(dir, "empty.yaml");
    writeFileSync(path, "{}\n");
    const policy = loadPolicyFile(path);
    expect(policy.mappings).toEqual({});
  });

  test("nonexistent file throws", () => {
    expect(() => loadPolicyFile(join(dir, "does-not-exist.yaml"))).toThrow();
  });

  test("enabled: false returns empty mappings even when mappings are present", () => {
    const path = join(dir, "disabled.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: false
  mappings:
    users: org_id
`,
    );
    const policy = loadPolicyFile(path);
    expect(policy.mappings).toEqual({});
  });
});
