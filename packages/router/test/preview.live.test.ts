// Live end-to-end: previewQuery against a REAL engine container + Postgres.
//
// Proves the masked-preview path top to bottom — the MCP client drives the
// agent's `query` tool against a spawned engine, the engine executes + masks
// (or fails closed), and the rows / structured rejection come back exactly as
// the panel renders them. The unit tests stub the MCP call; THIS test is the
// one that proves the SDK-client → real-engine → maskResultSet wiring works.
//
// Gated on PREVIEW_LIVE (needs Docker + a masking-capable engine image + a
// reachable Postgres), so normal CI skips it. To run:
//
//   docker run -d --name mp-mask-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
//     -p 55432:5432 postgres:16-alpine
//   docker exec -i mp-mask-pg psql -U postgres <<'SQL'
//     CREATE TABLE users (id int primary key, email text, ssn text, name text);
//     INSERT INTO users VALUES (1,'ada@acme.io','079-05-1120','Ada'),
//                              (2,'grace@navy.mil','078-05-1121','Grace');
//     CREATE VIEW users_v AS SELECT id, email FROM users;
//   SQL
//   PREVIEW_LIVE=1 MIDPLANE_OSS_IMAGE=midplane/midplane:dev \
//     ./node_modules/.bin/vitest run packages/router/test/preview.live.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { previewQuery } from "../src/preview.ts";
import { ContainerRegistry, type SpawnOptions } from "../src/spawner.ts";
import { DockerSpawner } from "../src/spawner-docker.ts";

const LIVE = process.env.PREVIEW_LIVE;
const d = LIVE ? describe : describe.skip;

// The DSN the ENGINE container uses to reach the host's Postgres. On Docker
// Desktop, host.docker.internal resolves to the host from inside a container.
const ENGINE_DSN =
  process.env.PREVIEW_LIVE_PG_DSN ??
  "postgres://postgres@host.docker.internal:55432/postgres";
const IMAGE =
  process.env.MIDPLANE_OSS_IMAGE ?? "midplane/midplane:dev";

const SPAWN: SpawnOptions = {
  projectId: "01HXYZPREVIEW00000000000000",
  region: "eu",
  maskSalt: "preview-e2e-salt",
  databases: [
    {
      name: "main",
      projectDatabaseId: "01HXYZMAIN0000000000000000",
      dsn: ENGINE_DSN,
      tableAccess: { default: "read", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
      guardrails: { block_unqualified_dml: true, block_ddl: true },
      columnMasks: {
        "public.users": { email: "full-redact", ssn: "consistent-hash" },
      },
    },
  ],
};

const reqFor = (sql: string) => ({
  database: "main",
  sql,
  intent: "masked-preview e2e",
  rowLimit: 25,
});

d("previewQuery — live engine + Postgres", () => {
  let registry: ContainerRegistry;

  beforeAll(() => {
    registry = new ContainerRegistry(new DockerSpawner({ image: IMAGE }));
  });
  afterAll(async () => {
    await registry?.shutdown().catch(() => undefined);
  });

  it("returns masked values for a direct base-table SELECT", async () => {
    const out = await previewQuery(
      SPAWN,
      reqFor("select id, email, ssn from users order by id"),
      { registry },
    );
    if (!out.ok || out.kind !== "rows") {
      throw new Error(`expected rows, got ${JSON.stringify(out)}`);
    }
    expect(out.rows.length).toBe(2);
    const r0 = out.rows[0] as Record<string, unknown>;
    // full-redact → constant token; consistent-hash → deterministic pseudonym
    // (NOT the real ssn); id passes through unmasked.
    expect(r0.email).toBe("***");
    expect(r0.ssn).not.toBe("079-05-1120");
    expect(typeof r0.ssn).toBe("string");
    expect(r0.id).toBe(1);
    // consistent-hash is deterministic — both rows' ssns differ from each other
    // and from the real values.
    const r1 = out.rows[1] as Record<string, unknown>;
    expect(r1.ssn).not.toBe(r0.ssn);
  }, 120_000);

  it("fails closed (column_masking) on a whole-row serialization", async () => {
    const out = await previewQuery(
      SPAWN,
      reqFor("select to_jsonb(users) as row from users"),
      { registry },
    );
    if (!out.ok) throw new Error(`expected an engine answer, got ${JSON.stringify(out)}`);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.policyRule).toBe("column_masking");
  }, 120_000);

  it("fails closed (column_masking) on a view over a masked column", async () => {
    const out = await previewQuery(
      SPAWN,
      reqFor("select id, email from users_v"),
      { registry },
    );
    if (!out.ok) throw new Error(`expected an engine answer, got ${JSON.stringify(out)}`);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.policyRule).toBe("column_masking");
  }, 120_000);
});
