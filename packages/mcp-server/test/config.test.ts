// Config schema tests.
//
// Brief: missing DATABASE_URL fails fast; unknown MIDPLANE_TRANSPORT fails;
// policy-file YAML parse errors fail.

import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DB_NAME,
  loadConfig,
  loadPolicyFile,
  parsePolicyYaml,
  resolveDatabasesFromConfig,
} from "../src/config.ts";

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

  test("valid YAML with tenant_scope mappings parses (legacy alias for overrides)", () => {
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
    expect(policy.tenantScope.defaultColumn).toBeNull();
    expect(policy.tenantScope.overrides).toEqual({ users: "org_id", posts: "org_id" });
    expect(policy.tenantScope.exempt).toEqual([]);
  });

  test("valid YAML with column + overrides + exempt parses (strict mode)", () => {
    const path = join(dir, "strict.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: true
  column: tenant_id
  overrides:
    orders: org_id
  exempt:
    - audit_log
    - regions
`,
    );
    const policy = loadPolicyFile(path);
    expect(policy.tenantScope.defaultColumn).toBe("tenant_id");
    expect(policy.tenantScope.overrides).toEqual({ orders: "org_id" });
    expect(policy.tenantScope.exempt).toEqual(["audit_log", "regions"]);
  });

  test("mappings + overrides in same doc → rejected", () => {
    const path = join(dir, "both.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: true
  mappings:
    users: org_id
  overrides:
    posts: org_id
`,
    );
    expect(() => loadPolicyFile(path)).toThrow(/both `mappings` and `overrides`/);
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

  test("missing tenant_scope returns empty config", () => {
    const path = join(dir, "empty.yaml");
    writeFileSync(path, "{}\n");
    const policy = loadPolicyFile(path);
    expect(policy.tenantScope.defaultColumn).toBeNull();
    expect(policy.tenantScope.overrides).toEqual({});
    expect(policy.tenantScope.exempt).toEqual([]);
  });

  test("nonexistent file throws", () => {
    expect(() => loadPolicyFile(join(dir, "does-not-exist.yaml"))).toThrow();
  });

  test("enabled: false returns empty config even when mappings/column are present", () => {
    const path = join(dir, "disabled.yaml");
    writeFileSync(
      path,
      `tenant_scope:
  enabled: false
  column: tenant_id
  mappings:
    users: org_id
  exempt:
    - audit_log
`,
    );
    const policy = loadPolicyFile(path);
    expect(policy.tenantScope.defaultColumn).toBeNull();
    expect(policy.tenantScope.overrides).toEqual({});
    expect(policy.tenantScope.exempt).toEqual([]);
  });
});

describe("parsePolicyYaml — databases[]", () => {
  test("databases[] with two entries parses + interpolates env", () => {
    const yaml = `databases:
  - name: prod
    url: \${PROD_URL}
    table_access:
      default: read
      tables:
        feature_flags: read_write
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`;
    const policy = parsePolicyYaml(yaml, "test", { PROD_URL: "postgres://prod" } as any);
    expect(policy.hasDatabasesBlock).toBe(true);
    expect(policy.databases).toHaveLength(2);

    expect(policy.databases[0]!.name).toBe("prod");
    expect(policy.databases[0]!.url).toBe("postgres://prod");
    expect(policy.databases[0]!.tenantScope.overrides).toEqual({ users: "org_id" });
    expect(policy.databases[0]!.tenantScope.defaultColumn).toBeNull();
    expect(policy.databases[0]!.tableAccess).toEqual({
      default: "read",
      tables: { feature_flags: "read_write" },
    });

    expect(policy.databases[1]!.name).toBe("analytics");
    expect(policy.databases[1]!.url).toBe("postgres://analytics");
    expect(policy.databases[1]!.tableAccess).toEqual({
      default: "read_write",
      tables: {},
    });
  });

  test("env interpolation on missing var throws with field path", () => {
    const yaml = `databases:
  - name: prod
    url: \${MISSING_VAR}
`;
    expect(() => parsePolicyYaml(yaml, "test", {} as any)).toThrow(/MISSING_VAR/);
  });

  test("name validation: lowercase, starts with letter", () => {
    const bad = `databases:
  - name: 1prod
    url: postgres://x
`;
    expect(() => parsePolicyYaml(bad, "test")).toThrow(/databases\[0\]\.name/);
    const upper = `databases:
  - name: Prod
    url: postgres://x
`;
    expect(() => parsePolicyYaml(upper, "test")).toThrow(/databases\[0\]\.name/);
  });

  test("name __default__ is reserved", () => {
    const yaml = `databases:
  - name: __default__
    url: postgres://x
`;
    expect(() => parsePolicyYaml(yaml, "test")).toThrow(/__default__/);
  });

  test("duplicate names rejected", () => {
    const yaml = `databases:
  - name: prod
    url: postgres://a
  - name: prod
    url: postgres://b
`;
    expect(() => parsePolicyYaml(yaml, "test")).toThrow(/duplicate database name/);
  });
});

describe("resolveDatabasesFromConfig", () => {
  test("legacy single-DB shape fills url from env DATABASE_URL", () => {
    const policy = parsePolicyYaml("table_access:\n  default: read\n  tables: {}\n", "test");
    const cfg = loadConfig({ DATABASE_URL: "postgres://legacy" });
    const dbs = resolveDatabasesFromConfig(policy, cfg);
    expect(dbs).toHaveLength(1);
    expect(dbs[0]!.name).toBe(DEFAULT_DB_NAME);
    expect(dbs[0]!.url).toBe("postgres://legacy");
  });

  test("legacy shape with no env DATABASE_URL throws", () => {
    const policy = parsePolicyYaml("table_access:\n  default: read\n  tables: {}\n", "test");
    const cfg = loadConfig({ MIDPLANE_POLICY_FILE: "/tmp/anything.yaml" });
    expect(() => resolveDatabasesFromConfig(policy, cfg)).toThrow(/DATABASE_URL/);
  });

  test("multi-DB shape ignores env DATABASE_URL but warns", () => {
    const policy = parsePolicyYaml(
      "databases:\n  - name: a\n    url: postgres://a\n",
      "test",
    );
    const cfg = loadConfig({ DATABASE_URL: "postgres://leg", MIDPLANE_POLICY_FILE: "/tmp/x.yaml" });
    const warnings: string[] = [];
    const dbs = resolveDatabasesFromConfig(policy, cfg, (m) => warnings.push(m));
    expect(dbs[0]!.url).toBe("postgres://a");
    expect(warnings.some((w) => /DATABASE_URL/.test(w))).toBe(true);
  });
});
