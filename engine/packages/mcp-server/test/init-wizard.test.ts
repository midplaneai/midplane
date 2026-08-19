// init-wizard — unit tests for the pure parts (candidate ranking, scaffold
// extensions) plus the non-TTY guard. The interactive flow itself is thin
// glue over these + @clack/prompts and is exercised manually; everything
// that can be wrong in a generated file is covered here.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import yaml from "js-yaml";
import { rankTenantCandidates, nextSteps, type ColumnRow } from "../src/init-wizard.ts";
import { scaffold } from "../src/policy-cli.ts";
import { PolicyFileSchema } from "../src/config.ts";
import { installShape, selfCliArgv } from "../src/runtime.ts";

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

describe("nextSteps", () => {
  const POLICY = "/home/dev/app/midplane.policy.yaml";
  const npx = (over: Partial<Parameters<typeof nextSteps>[0]> = {}) =>
    nextSteps({
      shape: "package",
      cliArgv: ["npx", "-y", "midplane"],
      policyPath: POLICY,
      dsnFromEnv: true,
      ...over,
    });

  // The whole point: someone who arrived through `npx midplane init` must not
  // be handed the install path they were avoiding.
  test("the npm package gets stdio steps, never docker", () => {
    const out = npx();
    expect(out).not.toContain("docker run");
    expect(out).not.toContain("-p 8080:8080");
    expect(out).not.toContain("http://localhost:8080/mcp");
    expect(out).toContain("npx -y midplane server --stdio");
    expect(out).toContain("no server to start");
  });

  test("the client snippet is valid JSON and spawns this install", () => {
    const out = npx();
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as {
      mcpServers: {
        midplane: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    const entry = parsed.mcpServers.midplane;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midplane", "server", "--stdio"]);
    // Absolute, because the client spawns from a working directory the user
    // never chose — a relative path would resolve somewhere else.
    expect(entry.env.MIDPLANE_POLICY_FILE).toBe(POLICY);
    // The real DSN is never echoed, on any path.
    expect(entry.env.DATABASE_URL).toBe("postgres://user:pass@host:5432/db");
  });

  test("bunx and a source checkout each get their own spawn", () => {
    expect(npx({ cliArgv: ["bunx", "midplane"] })).toContain("bunx midplane server --stdio");
    const source = npx({ shape: "source", cliArgv: ["bun", "/repo/src/cli.ts"] });
    expect(source).toContain("bun /repo/src/cli.ts server --stdio");
    expect(source).toContain('"args": ["/repo/src/cli.ts", "server", "--stdio"]');
  });

  // A path with a comma in it must survive into the config verbatim — the
  // inline `args` array is assembled from JSON-encoded elements, not by
  // reformatting a serialized one.
  test("an awkward entry path round-trips through the snippet", () => {
    const entry = "/repo/a, b/cli.ts";
    const out = npx({ shape: "source", cliArgv: ["bun", entry] });
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { mcpServers: { midplane: { args: string[] } } };
    expect(parsed.mcpServers.midplane.args).toEqual([entry, "server", "--stdio"]);
  });

  test('DSN in the env → "$DATABASE_URL"; typed at the prompt → export it', () => {
    expect(npx({ dsnFromEnv: true })).toContain('-e DATABASE_URL="$DATABASE_URL"');
    expect(npx({ dsnFromEnv: true })).not.toContain("export DATABASE_URL");
    // An unset "$DATABASE_URL" would expand to empty and register a broken
    // server, so the value has to be asked for instead.
    const typed = npx({ dsnFromEnv: false });
    expect(typed).not.toContain('"$DATABASE_URL"');
    expect(typed).toContain("export DATABASE_URL");
  });

  test("verification commands are runnable as printed", () => {
    const out = npx();
    expect(out).toContain(`export MIDPLANE_POLICY_FILE=${POLICY}`);
    expect(out).toContain("npx -y midplane doctor");
    // Without --stdio, `query` would look for an HTTP server nothing started.
    expect(out).toContain('npx -y midplane query --stdio --sql "SELECT 1"');
  });

  test("the image still gets docker steps, with an absolute mount source", () => {
    const out = nextSteps({
      shape: "docker",
      cliArgv: ["midplane"],
      policyPath: POLICY,
      dsnFromEnv: true,
    });
    expect(out).toContain("docker run --env-file .env -p 8080:8080");
    expect(out).toContain(`-v ${POLICY}:/policy.yaml`);
    expect(out).toContain("claude mcp add --transport http midplane http://localhost:8080/mcp");
    expect(out).toContain('midplane query --sql "SELECT 1"');
  });

  test("this build detects itself as a source checkout", () => {
    // The suite runs `bun src/cli.ts` out of the repo — neither the compiled
    // binary nor a node_modules install.
    expect(installShape()).toBe("source");
    const argv = selfCliArgv();
    expect(argv[0]).toBe("bun");
    expect(argv[1]).toMatch(/cli\.ts$/);
    expect(nextSteps({ shape: installShape(), cliArgv: argv, policyPath: POLICY, dsnFromEnv: true }))
      .not.toContain("docker run");
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
