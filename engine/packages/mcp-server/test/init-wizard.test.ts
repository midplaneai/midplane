// init-wizard — unit tests for the pure parts (candidate ranking, scaffold
// extensions) plus the non-TTY guard. The interactive flow itself is thin
// glue over these + @clack/prompts and is exercised manually; everything
// that can be wrong in a generated file is covered here.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import yaml from "js-yaml";
import { rankTenantCandidates, type ColumnRow } from "../src/init-wizard.ts";
import { scaffold } from "../src/policy-cli.ts";
import { PolicyFileSchema } from "../src/config.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

function cols(...pairs: Array<[string, string]>): ColumnRow[] {
  return pairs.map(([table_name, column_name]) => ({ table_name, column_name }));
}

describe("rankTenantCandidates", () => {
  test("ranks by coverage, then by name preference", () => {
    const tables = ["users", "orders", "items"];
    const ranked = rankTenantCandidates(
      cols(
        ["users", "org_id"],
        ["orders", "org_id"],
        ["items", "org_id"],
        ["users", "tenant_id"],
        ["orders", "tenant_id"],
      ),
      tables,
    );
    expect(ranked[0]!.column).toBe("org_id"); // 3/3 beats 2/3
    expect(ranked[0]!.tables).toEqual(["items", "orders", "users"]);
    expect(ranked[1]!.column).toBe("tenant_id");
  });

  test("equal coverage prefers tenant_id over customer_id", () => {
    const ranked = rankTenantCandidates(
      cols(["a", "customer_id"], ["a", "tenant_id"]),
      ["a"],
    );
    expect(ranked.map((c) => c.column)).toEqual(["tenant_id", "customer_id"]);
  });

  test("tenant-ish names qualify; ordinary FKs don't", () => {
    const ranked = rankTenantCandidates(
      cols(["a", "tenant_uuid"], ["a", "user_id"], ["a", "created_at"]),
      ["a"],
    );
    expect(ranked.map((c) => c.column)).toEqual(["tenant_uuid"]);
  });

  test("columns on tables outside the table list (views) are ignored", () => {
    const ranked = rankTenantCandidates(
      cols(["real_table", "tenant_id"], ["some_view", "tenant_id"]),
      ["real_table"],
    );
    expect(ranked[0]!.tables).toEqual(["real_table"]);
  });

  test("no candidates → empty list", () => {
    expect(rankTenantCandidates(cols(["a", "id"]), ["a"])).toEqual([]);
  });
});

describe("scaffold with wizard extensions", () => {
  test("grants render per-table levels and the file validates", () => {
    const text = scaffold({
      tables: ["users", "feature_flags", "secrets"],
      tenantColumn: "tenant_id",
      introspected: true,
      grants: { feature_flags: "read_write", secrets: "deny" },
      exempt: ["audit_log", "plans"],
    });
    const doc = yaml.load(text);
    const parsed = PolicyFileSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    const ta = parsed.data!.table_access!;
    expect(ta.tables["public.users"]).toBe("read");
    expect(ta.tables["public.feature_flags"]).toBe("read_write");
    expect(ta.tables["public.secrets"]).toBe("deny");
    expect(parsed.data!.tenant_scope!.exempt).toEqual(["audit_log", "plans"]);
    // The flip hint stays on default-read lines only.
    expect(text).toMatch(/public\.users: +read +# → read_write/);
    expect(text).not.toMatch(/read_write +#/);
  });

  test("empty exempt list renders as [] and validates", () => {
    const text = scaffold({
      tables: ["users"],
      tenantColumn: "tenant_id",
      introspected: true,
      grants: {},
      exempt: [],
    });
    const parsed = PolicyFileSchema.safeParse(yaml.load(text));
    expect(parsed.success).toBe(true);
    expect(parsed.data!.tenant_scope!.exempt).toEqual([]);
  });

  test("without wizard fields the output keeps the classic shape", () => {
    const text = scaffold({ tables: ["users"], tenantColumn: undefined, introspected: true });
    expect(text).toContain("public.users: read   # → read_write to allow writes");
    expect(text).toContain("# tenant_scope: (disabled)");
  });
});

describe("midplane init (non-interactive contexts)", () => {
  test("no TTY → exit 2 pointing at policy init", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "init"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdin: "pipe", // a pipe is not a TTY
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("midplane policy init");
  });

  test("help init prints usage", async () => {
    const proc = Bun.spawn(["bun", CLI_PATH, "help", "init"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("midplane init");
    expect(stdout).toContain("tenant");
  });
});
