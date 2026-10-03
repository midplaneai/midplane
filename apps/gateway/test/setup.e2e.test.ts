// `midplane setup`'s connection test checks the role it connects as, and
// warns of a superuser or of a role that can drop tables whatever its grants:
// their owner, their schema's owner, or a member of either. The check never
// fails the test. Changing owners and catalog privileges needs a superuser
// admin, as CI's is; other admins skip those tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prompter } from "../src/prompt.ts";
import { askDatabases, planSetup, testConnection } from "../src/setup.ts";
import { createDatabase, hasPostgres, type TestDatabase } from "./harness.ts";

describe.skipIf(!hasPostgres)("the connection test's role check", () => {
  let db: TestDatabase;
  let owner: string;
  let superuser: boolean;

  beforeAll(async () => {
    db = await createDatabase(
      "CREATE TABLE notes (id int); CREATE TABLE drafts (id int);",
      (role) => `GRANT SELECT ON notes, drafts TO ${role};`,
    );
    owner = `${db.role}_owner`;
    const { rows } = await db.admin(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    superuser = rows[0]?.rolsuper === true;
  }, 60_000);

  afterAll(async () => {
    await db?.admin(
      `DROP TABLE IF EXISTS drafts; DROP ROLE IF EXISTS ${owner}`,
    );
    await db?.drop();
  });

  const warning = async (dsn: string) => {
    const test = await testConnection(dsn);
    expect(test.ok).toBe(true);
    return test.ok ? test.warning : undefined;
  };

  it("warns of nothing for a role with only grants", async () => {
    expect(await testConnection(db.agentDsn)).toMatchObject({
      ok: true,
      role: db.role,
      warning: null,
    });
  });

  it("warns of a superuser", async (ctx) => {
    if (!superuser) ctx.skip();
    expect(await warning(db.adminDsn)).toBe("superuser");
  });

  it("warns of a table's owner, its schema's, or a member of one, and setup prints it", async (ctx) => {
    if (!superuser) ctx.skip();
    await db.admin(`ALTER TABLE drafts OWNER TO ${db.role}`);
    expect(await warning(db.agentDsn)).toBe("owns_tables");

    // The database's owner, which owns `public` as on Postgres 15 and later.
    await db.admin(
      `ALTER TABLE drafts OWNER TO CURRENT_USER; ALTER SCHEMA public OWNER TO pg_database_owner; ALTER DATABASE ${db.name} OWNER TO ${db.role}`,
    );
    expect(await warning(db.agentDsn)).toBe("owns_tables");

    // A member of the table's owner that doesn't inherit it can still SET ROLE.
    await db.admin(
      `ALTER DATABASE ${db.name} OWNER TO CURRENT_USER; CREATE ROLE ${owner} NOLOGIN; ALTER ROLE ${db.role} NOINHERIT; GRANT ${owner} TO ${db.role}; ALTER TABLE drafts OWNER TO ${owner}`,
    );
    const answers = [db.agentDsn, "n"];
    const prompter: Prompter = {
      ask: async () => answers.shift() ?? "",
      close: () => {},
    };
    let out = "";
    const plan = planSetup({
      cloud: "https://eu.app.midplane.ai",
      token: `mpe1_${"A".repeat(86)}`,
      database: ["main"],
    });
    await askDatabases(plan, { prompter, out: (text) => (out += text) });
    expect(out).toContain(
      `  warning: ${db.role} owns tables in ${db.name}, or their schema, so Postgres lets it drop them whatever its grants. Midplane can only narrow what this role may do: give the gateway a role with only what agents should ever be able to do (https://midplane.ai/docs/prepare-database).\n`,
    );
  });

  it("passes the test when the check itself fails", async (ctx) => {
    if (!superuser) ctx.skip();
    await db.admin(`ALTER TABLE drafts OWNER TO ${db.role}`);
    await db.admin("REVOKE SELECT ON pg_catalog.pg_roles FROM PUBLIC");
    try {
      expect(await testConnection(db.agentDsn)).toMatchObject({
        ok: true,
        tables: 2,
        warning: null,
      });
    } finally {
      await db.admin("GRANT SELECT ON pg_catalog.pg_roles TO PUBLIC");
    }
  });
});
