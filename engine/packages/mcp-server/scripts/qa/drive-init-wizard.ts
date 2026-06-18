// Manual QA: drive the REAL `midplane init` wizard end-to-end against a live
// Postgres and assert the policy it writes. Not a unit test and not wired into
// `bun test` — the wizard is the one fully-interactive surface, it needs a
// real TTY + a real DB to introspect, and the pure logic is already covered by
// test/init-wizard.test.ts. This is the smoke test you run by hand (or in a
// DB-having job) when you touch the wizard.
//
// Usage:
//   DATABASE_URL=postgres://… bun scripts/qa/drive-init-wizard.ts
//   bun scripts/qa/drive-init-wizard.ts --url postgres://… \
//       --tenant-column tenant_id --write orders --deny api_keys [--keep]
//
// How it stays robust to ANY schema: instead of hardcoding "press DOWN twice",
// it introspects the same way the wizard does (the dialect's listTablesSql +
// an information_schema columns query) to learn the option ORDER, then computes
// the exact keystrokes to toggle the tables you asked for. Change your schema
// and it still drives correctly.

import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { postgresDialect } from "@midplane/engine";
import { newCliPgClient } from "../../src/dsn.ts";
import { PolicyFileSchema } from "../../src/config.ts";
import { displayHost } from "../../src/dsn.ts";
import { spawnPty, Keys, tick } from "./pty.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function fail(msg: string, transcript?: string): never {
  console.error(`\n✗ FAIL: ${msg}`);
  if (transcript) console.error(`\n--- last 800 chars of wizard output ---\n${transcript.slice(-800)}`);
  process.exit(1);
}

async function introspect(url: string): Promise<{ tables: string[]; columnsByTable: Map<string, Set<string>> }> {
  const client = await newCliPgClient(url);
  await client.connect();
  try {
    const tablesRes = await client.query(postgresDialect.listTablesSql!("public"));
    const tables = (tablesRes.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    const colsRes = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    const columnsByTable = new Map<string, Set<string>>();
    for (const r of colsRes.rows as Array<{ table_name: string; column_name: string }>) {
      let set = columnsByTable.get(r.table_name);
      if (!set) columnsByTable.set(r.table_name, (set = new Set()));
      set.add(r.column_name);
    }
    return { tables, columnsByTable };
  } finally {
    await client.end().catch(() => {});
  }
}

// Toggle a set of option indices in a clack multiselect whose cursor starts at
// index 0, then submit. Indices must be within the option list.
async function toggleByIndices(
  s: ReturnType<typeof spawnPty>,
  indices: number[],
): Promise<void> {
  let cur = 0;
  for (const idx of [...indices].sort((a, b) => a - b)) {
    while (cur < idx) {
      s.send(Keys.DOWN);
      await tick();
      cur++;
    }
    s.send(Keys.SPACE);
    await tick();
  }
  s.send(Keys.ENTER);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const url = flags.url ?? process.env.DATABASE_URL;
  if (!url) fail("set DATABASE_URL or pass --url <dsn>");
  const tenantColumn = flags["tenant-column"] ?? "tenant_id";
  const writeTargets = (flags.write ?? "orders").split(",").map((s) => s.trim()).filter(Boolean);
  const denyTargets = (flags.deny ?? "api_keys").split(",").map((s) => s.trim()).filter(Boolean);

  const tmp = mkdtempSync(join(tmpdir(), "midplane-qa-"));
  const out = flags.out ?? join(tmp, "midplane.policy.yaml");

  console.log(`▶ init wizard QA against ${displayHost(url!)}`);
  console.log(`  tenant-column=${tenantColumn}  write=[${writeTargets}]  deny=[${denyTargets}]  out=${out}`);

  // 1. Learn the option ORDER the wizard will render (same SQL it uses).
  const { tables, columnsByTable } = await introspect(url!);
  if (tables.length === 0) fail("no tables in `public` — seed a schema first");

  for (const t of [...writeTargets, ...denyTargets]) {
    if (!tables.includes(t)) fail(`requested table "${t}" is not in the DB (have: ${tables.join(", ")})`);
  }

  // Tables lacking the tenant column → the wizard shows an "exempt" multiselect
  // (pre-selecting all of them); accept that default with ENTER.
  const missing = tables.filter((t) => !(columnsByTable.get(t)?.has(tenantColumn)));
  const writeSet = new Set(writeTargets);
  // The deny multiselect only lists tables NOT already granted write, in the
  // same alphabetical order.
  const denyable = tables.filter((t) => !writeSet.has(t));

  const writeIdx = writeTargets.map((t) => tables.indexOf(t));
  const denyIdx = denyTargets.map((t) => denyable.indexOf(t));

  // 2. Drive the real wizard.
  const s = spawnPty([process.execPath, CLI, "init", "--url", url!, "--tenant-column", tenantColumn, "-o", out]);
  try {
    if (missing.length > 0) {
      await s.waitFor("span tenants");
      await tick();
      s.send(Keys.ENTER); // accept the pre-selected exempt set (= `missing`)
    }
    await s.waitFor("WRITE to");
    await tick();
    await toggleByIndices(s, writeIdx);

    await s.waitFor("deny entirely");
    await tick();
    await toggleByIndices(s, denyIdx);

    await s.waitFor("never in the file"); // outro
    const code = await s.exited;
    s.close();
    if (code !== 0) fail(`wizard exited ${code}`, s.output());
  } catch (err) {
    s.kill();
    fail((err as Error).message, s.output());
  }

  // 3. Assert the written policy.
  const text = readFileSync(out, "utf8");
  const checks: Array<[string, boolean]> = [];

  // DSN never lands in the file.
  let leaked = false;
  try {
    const pw = new URL(url!).password;
    leaked = pw.length > 0 && text.includes(pw);
  } catch {
    /* non-URL dsn form — skip */
  }
  checks.push(["DSN not written to file", !leaked && !text.includes("@")]);

  const parsed = PolicyFileSchema.safeParse(yaml.load(text));
  checks.push(["validates against PolicyFileSchema", parsed.success]);

  if (parsed.success) {
    const ta = parsed.data.table_access;
    const ts = parsed.data.tenant_scope;
    for (const t of writeTargets) {
      checks.push([`${t} → read_write`, ta?.tables[`public.${t}`] === "read_write"]);
    }
    for (const t of denyTargets) {
      checks.push([`${t} → deny`, ta?.tables[`public.${t}`] === "deny"]);
    }
    checks.push([`tenant_scope.column = ${tenantColumn}`, ts?.column === tenantColumn && ts?.enabled !== false]);
    if (missing.length > 0) {
      const exempt = new Set(ts?.exempt ?? []);
      checks.push([`exempt covers tenant-less tables [${missing}]`, missing.every((t) => exempt.has(t))]);
    }
  }

  console.log("");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }

  if (!flags.keep && !flags.out) rmSync(tmp, { recursive: true, force: true });
  else console.log(`\n  policy kept at ${out}`);

  if (!ok) fail("one or more assertions failed", text);
  console.log("\n✓ PASS — wizard drove cleanly and wrote a correct, DSN-free policy.");
}

main().catch((err) => fail((err as Error).message));
