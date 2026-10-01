// Catalog snapshots end to end, against Postgres and a stand-in cloud: the
// gateway redacts, hashes and uploads each database's catalog, once per
// change, re-reads it when stale or on command, and never lets a value, the
// DSN or the salt leave. That last part is invariant 9's gateway half: every
// body the gateway sends is scanned for secrets seeded in the database.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadParser,
  unredactedDefinitions,
  withheldViews,
} from "@midplane/core";
import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  RefreshCatalogResultSchema,
} from "@midplane/protocol";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { parseLinkedConfig } from "../src/config.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
import { createDatabase, hasPostgres, type TestDatabase } from "./harness.ts";
import { CREATE_VIEWS, SEEDED, VIEW_TABLES, WITHHELD } from "./views.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!hasPostgres)("catalog snapshots", { timeout: 30_000 }, () => {
  let db: TestDatabase;
  let cloud: FakeCloud;
  let gw: RunningGateway;
  let stderr: MockInstance;
  const logged: string[] = [];
  const env: NodeJS.ProcessEnv = {};

  const stored = () => {
    const cat = cloud.catalogs.get("main");
    if (!cat) throw new Error("no catalog stored");
    return {
      ...cat,
      snapshot: CatalogSnapshotSchema.parse(JSON.parse(cat.body)),
    };
  };
  /** Let the gateway sync `n` more times. */
  const syncs = async (n: number) => {
    const target = cloud.statuses.length + n;
    await waitFor(`${n} syncs`, () => cloud.statuses.length >= target);
  };
  const refresh = async () => {
    const id = cloud.command("refresh_catalog");
    await waitFor("the refresh's result", () => cloud.results.has(id));
    const r = cloud.results.get(id);
    if (!r?.ok) throw new Error("refresh_catalog failed");
    return RefreshCatalogResultSchema.parse(r.result).databases.main;
  };

  beforeAll(async () => {
    await loadParser();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    db = await createDatabase(
      `${VIEW_TABLES}
       ${CREATE_VIEWS}
       CREATE TABLE users (id int PRIMARY KEY,
         email text DEFAULT 'default-s3cr3t',
         ssn text CHECK (ssn <> 'check-s3cr3t'));
       COMMENT ON COLUMN users.email IS 'comment-s3cr3t';
       INSERT INTO users VALUES (1, 'row-s3cr3t@example.com', '4711-47-11');
       INSERT INTO t (id, name, amount) VALUES (4711, 'row-s3cr3t', 47.11);
       ANALYZE;`,
      (role) => `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`,
    );
    cloud = await startFakeCloud();
    const dir = mkdtempSync(join(tmpdir(), "midplane-catalog-"));
    const port = await freePort();
    env.SALT = randomBytes(32).toString("hex");
    env.DSN_MAIN = db.agentDsn;
    env.ENROLL = cloud.enrollmentToken();
    const text = JSON.stringify({
      listen: { host: "127.0.0.1", port },
      audit: { file: "audit.db" },
      mask_salt: { env: "SALT" },
      link: {
        cloud_url: cloud.url,
        identity: { file: "identity.json" },
        enrollment_token: { env: "ENROLL" },
      },
      databases: { main: { dsn: { env: "DSN_MAIN" } } },
    });
    const path = join(dir, "midplane.yaml");
    writeFileSync(path, text);
    gw = await startLinked(parseLinkedConfig(text, path, env), {
      retry: { minMs: 50, maxMs: 200, cutMs: 200 },
      catalogMaxAgeMs: 250,
    });
    await cloud.publish({
      main: { table_access: { default: "read" }, masks: {} },
    });
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await cloud?.close();
    await db?.drop();
    stderr?.mockRestore();
  });

  it("uploads its catalog redacted, and every status carries the upload's hash", async () => {
    await waitFor("an upload", () => cloud.catalogs.has("main"));
    const { sha256, snapshot } = stored();
    expect(unredactedDefinitions(snapshot)).toEqual([]);
    expect(withheldViews(snapshot)).toEqual(WITHHELD);
    const names = snapshot.relations.map((r) => `${r.schema}.${r.name}`);
    expect(names).toContain("public.users");
    expect(names).toContain("public.v_extract");
    expect(names).toContain("information_schema.tables");
    await waitFor("a status naming it", () =>
      cloud.statuses.some((s) => s.catalogs?.main === sha256),
    );
  });

  it("logs the views it withholds, once, with why", () => {
    const lines = logged
      .filter((l) => l.includes("view definitions withheld"))
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      database: "main",
      views: WITHHELD.map((view) => ({
        view,
        reason: "it could not be printed back faithfully",
      })),
    });
  });

  it("reads the same catalog the postgres-views corpus was made from, on Postgres 17", async (ctx) => {
    const version = await db.admin("SHOW server_version_num");
    const major = Math.floor(
      Number(version.rows[0].server_version_num) / 10_000,
    );
    if (major !== 17) ctx.skip();
    const corpus = CatalogSnapshotSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../packages/corpus/catalogs/postgres-views.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    const main = gw.gateway.catalogs().find((c) => c.id === "main")
      ?.catalog as CatalogSnapshot;
    const ours = main.relations.filter(
      (r) =>
        r.schema === "public" &&
        /^(t|u|v_.*)$/.test(r.name) &&
        !WITHHELD.includes(`public.${r.name}`),
    );
    expect(ours).toEqual(corpus.relations);
  });

  it("re-reads a stale catalog before each sync, but uploads only a change", async () => {
    const before = cloud.uploads.length;
    await syncs(4);
    expect(cloud.uploads.length).toBe(before);

    await db.admin("CREATE TABLE added (id int, note text)");
    await waitFor(
      "the change's upload",
      () =>
        cloud.catalogs.get("main")?.body.includes('"name":"added"') ?? false,
    );
    expect(cloud.uploads.length).toBe(before + 1);
    const { sha256 } = stored();
    await waitFor("a status naming the new hash", () =>
      cloud.statuses.some((s) => s.catalogs?.main === sha256),
    );
  });

  it("refresh_catalog re-reads and sends even an unchanged catalog", async () => {
    const before = cloud.uploads.length;
    const { sha256 } = stored();
    expect(await refresh()).toEqual({ ok: true, sha256, code: null });
    expect(cloud.uploads.length).toBe(before + 1);
  });

  it("doesn't retry a refused upload until the catalog changes", async () => {
    cloud.refuseCatalogs(413);
    await db.admin("CREATE TABLE added2 (id int)");
    await waitFor("a refused upload", () =>
      cloud.uploads.some((u) => u.status === 413),
    );
    const refused = cloud.uploads.length;
    await syncs(4);
    expect(cloud.uploads.length).toBe(refused);
    expect(await refresh()).toMatchObject({ ok: false, code: "http_413" });

    cloud.refuseCatalogs(null);
    await db.admin("CREATE TABLE added3 (id int)");
    await waitFor(
      "the next change's upload",
      () =>
        cloud.catalogs.get("main")?.body.includes('"name":"added3"') ?? false,
    );
  });

  it("uploads each hash once, even while the cloud holds another", async () => {
    // What two gateways under one alias that see different catalogs look
    // like to each: the cloud keeps the other's.
    cloud.echoCatalogs({ main: "0".repeat(64) });
    await db.admin("CREATE TABLE added4 (id int)");
    await waitFor(
      "the change's upload",
      () =>
        cloud.catalogs.get("main")?.body.includes('"name":"added4"') ?? false,
    );
    const uploaded = cloud.uploads.length;
    await syncs(4);
    expect(cloud.uploads.length).toBe(uploaded);
    cloud.echoCatalogs(null);
  });

  it("invariant 9: nothing it sends carries a value, the DSN or the salt", async () => {
    const test = cloud.command("test_connection");
    await waitFor("the connection test's result", () =>
      cloud.results.has(test),
    );
    const paths = new Set(cloud.bodies.map((b) => b.path));
    expect(paths).toEqual(
      new Set([
        "/link/v1/enroll",
        "/oauth2/token",
        "/link/v1/sync",
        "/link/v1/catalogs/main",
        `/link/v1/commands/${test}`,
        ...[...cloud.results.keys()].map((id) => `/link/v1/commands/${id}`),
      ]),
    );
    const password = new URL(db.agentDsn).password;
    const secrets = [...SEEDED, db.agentDsn, password, env.SALT as string];
    for (const { path, body } of cloud.bodies) {
      // A hash can hold any four digits, so numbers are looked for around them.
      const text = body.replace(/[0-9a-f]{64}/g, "");
      for (const s of secrets)
        expect(text, `${path} holds ${s}`).not.toContain(s);
    }
  });
});
