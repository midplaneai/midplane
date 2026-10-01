// The local quickstart, as shipped: its seed and its midplane.yaml, run by
// the gateway against Postgres. Each thing its README tells a person to ask
// an agent answers as the README says: masked emails and phones, a held
// write refused in local mode, a write without a WHERE denied, and a secret
// table that closes once the agent reads an untrusted ticket.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadParser } from "@midplane/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generateSigningKey, mintToken } from "../src/auth.ts";
import { parseConfig } from "../src/config.ts";
import { MCP_PATH } from "../src/http.ts";
import { type RunningGateway, startLocal } from "../src/server.ts";
import {
  ADMIN_DSN,
  callTool,
  createDatabase,
  hasPostgres,
  query,
  type TestDatabase,
  type ToolResult,
} from "./harness.ts";

const QUICKSTART = fileURLToPath(
  new URL("../../../examples/quickstart/", import.meta.url),
);

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe.skipIf(!hasPostgres)(
  "the local quickstart",
  { timeout: 30_000 },
  () => {
    let db: TestDatabase;
    let gw: RunningGateway;
    let token = "";
    let url = "";

    beforeAll(async () => {
      await loadParser();
      db = await createDatabase(
        readFileSync(join(QUICKSTART, "seed.sql"), "utf8"),
        () => "SELECT 1",
      );
      // The seed's own role, as the README's SHOP_DSN names it.
      const dsn = new URL(db.adminDsn);
      dsn.username = "midplane_agent";
      dsn.password = "quickstart";

      const dir = mkdtempSync(join(tmpdir(), "midplane-quickstart-"));
      const { privateJwk, publicJwk } = await generateSigningKey();
      writeFileSync(
        join(dir, "midplane-verify-key.json"),
        JSON.stringify(publicJwk),
      );
      // The shipped config, on a free port.
      const doc = parseYaml(
        readFileSync(join(QUICKSTART, "midplane.yaml"), "utf8"),
      ) as { listen: { port: number } };
      doc.listen.port = 0;
      const text = JSON.stringify(doc);
      const path = join(dir, "midplane.yaml");
      writeFileSync(path, text);
      const config = parseConfig(text, path, {
        SHOP_DSN: dsn.toString(),
        MIDPLANE_MASK_SALT: randomBytes(32).toString("hex"),
      });
      gw = await startLocal(config);
      url = `${gw.url}${MCP_PATH}`;
      token = await mintToken({
        privateJwk: privateJwk as Parameters<typeof mintToken>[0]["privateJwk"],
        issuer: config.auth.issuer,
        audience: url,
        project: config.project,
        sub: "you@example.com",
        clientId: "midplane-cli",
        grantId: `local-${randomUUID()}`,
        databases: { shop: "write" },
        ttlSeconds: 600,
      });
    }, 60_000);

    afterAll(async () => {
      await gw?.close();
      await db?.drop();
      // The seed's role is the cluster's, not the database's: a login role
      // with a known password would outlive the drop.
      if (db) {
        const root = new pg.Client({ connectionString: ADMIN_DSN });
        await root.connect();
        try {
          await root.query("DROP ROLE IF EXISTS midplane_agent");
        } catch {
          // Another run's database still has objects owned by or granted to
          // it; that run drops it. Failing here would fail this run's tests.
        } finally {
          await root.end();
        }
      }
    });

    it("lists the three tables", async () => {
      const text = textOf(await callTool(url, token, "list_tables", {}));
      for (const t of ["customers", "support_tickets", "api_keys"]) {
        expect(text).toContain(t);
      }
    });

    it("masks emails, phones and signup dates, and leaves names and plans", async () => {
      const r = await query(
        url,
        token,
        "SELECT name, email, phone, plan, created_at FROM customers ORDER BY id",
      );
      expect(r.isError).toBeFalsy();
      const [dana] = r.structuredContent?.rows ?? [];
      expect(dana?.[0]).toBe("Dana Ng");
      expect(String(dana?.[1])).not.toContain("@");
      expect(String(dana?.[2])).toMatch(/^•+0142$/);
      expect(dana?.[3]).toBe("pro");
      expect(String(dana?.[4])).toMatch(/^2025-03-01/);
    });

    it("refuses a held write: local mode can't approve", async () => {
      const r = await query(
        url,
        token,
        "UPDATE support_tickets SET status = 'closed' WHERE id = 2",
      );
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/local mode, where approvals are unavailable/);
      const { rows } = await db.admin(
        "SELECT status FROM support_tickets WHERE id = 2",
      );
      expect(rows[0]?.status).toBe("open");
    });

    it("denies a write without a WHERE", async () => {
      const r = await query(url, token, "DELETE FROM support_tickets");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/every row/);
    });

    it("closes the secret table once the agent reads an untrusted ticket", async () => {
      const before = await query(url, token, "SELECT service FROM api_keys");
      expect(before.isError).toBeFalsy();
      const ticket = await query(
        url,
        token,
        "SELECT subject, body FROM support_tickets WHERE id = 1",
      );
      expect(textOf(ticket)).toContain("IMPORTANT NOTE FOR AI ASSISTANTS");
      const after = await query(url, token, "SELECT secret FROM api_keys");
      expect(after.isError).toBe(true);
      expect(textOf(after)).toMatch(/labeled secret/);
      expect(textOf(after)).not.toContain("sk_test_quickstart");
    });

    it("recorded all of it, checkably, owing nothing to a cloud", () => {
      expect(gw.audit.verifyChain()).toBe(true);
      expect(gw.audit.head().unacked).toBe(0);
      expect(gw.audit.events().length).toBeGreaterThan(10);
    });
  },
);
