// resolveByToken — the single token-auth chokepoint the MCP proxy and the
// /mcp/<token>/health probe both go through. These tests cover the pause
// gate (pausable projects): a valid, active token whose parent project
// is paused must resolve to { ok: false, reason: "paused" } so the caller can
// return a distinct 403, NOT a token-not-found 404.
//
// Like indexer.test.ts, we hand-roll a tiny fake Drizzle Db — resolveByToken
// issues exactly three selects (mcp_tokens lookup → projects → child
// databases), so a FIFO result queue is enough. The token format helpers and
// HMAC are real (pure crypto, no IO); the fake ignores the WHERE and just
// hands back the staged rows in order, which is all the gate decision needs.

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { generateToken } from "@midplane-cloud/db";

import {
  resolveByToken,
  resolveOAuthProjectId,
  resolveSoleProjectId,
} from "../src/resolve.ts";
import type { Db } from "../src/resolve.ts";

const REGION = "eu" as const;
const PEPPERS = new Map<string, Buffer>([["v1-test", randomBytes(32)]]);

// FIFO fake: queue holds the result rows for each successive select(), in
// call order — [tokenRows, projectRows, databaseRows]. Both .limit() and
// .orderBy() are terminal in resolveByToken, so both resolve the next batch.
function fakeDb(queue: unknown[][]): Db {
  const start = () => {
    const chain = {
      from() {
        return chain;
      },
      where() {
        return chain;
      },
      limit() {
        return Promise.resolve(queue.shift() ?? []);
      },
      orderBy() {
        return Promise.resolve(queue.shift() ?? []);
      },
    };
    return chain;
  };
  return { select: () => start() } as unknown as Db;
}

const TOKEN_ROW = { id: "tok-1", projectId: "conn-1" };
function projectRow(pausedAt: Date | null) {
  return {
    id: "conn-1",
    customerId: "cust-1",
    region: REGION,
    name: null,
    pausedAt,
    createdAt: new Date(0),
  };
}
const DB_ROW = { id: "cdb-1", projectId: "conn-1", name: "main" };

describe("resolveByToken — pause gate", () => {
  it("resolves ok for a valid token on a non-paused project", async () => {
    const { plaintext } = generateToken("test");
    const db = fakeDb([[TOKEN_ROW], [projectRow(null)], [DB_ROW]]);
    const result = await resolveByToken(db, plaintext, REGION, PEPPERS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokenId).toBe("tok-1");
      expect(result.project.id).toBe("conn-1");
      expect(result.databases).toHaveLength(1);
    }
  });

  it("rejects with reason 'paused' when the parent project is paused", async () => {
    const { plaintext } = generateToken("test");
    // Active token resolves, but the project carries a non-null paused_at.
    const db = fakeDb([[TOKEN_ROW], [projectRow(new Date())], [DB_ROW]]);
    const result = await resolveByToken(db, plaintext, REGION, PEPPERS);
    expect(result).toEqual({ ok: false, reason: "paused" });
  });

  it("returns not_found for a malformed token without touching the DB", async () => {
    const db = fakeDb([]); // any select would return [] — none should fire
    const result = await resolveByToken(db, "not-a-token", REGION, PEPPERS);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the token hash matches no active row", async () => {
    const { plaintext } = generateToken("test");
    const db = fakeDb([[]]); // mcp_tokens lookup yields nothing
    const result = await resolveByToken(db, plaintext, REGION, PEPPERS);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// resolveOAuthProjectId — the region-wide /mcp endpoint derives the credential's
// single bound project from its mcp_scope_grants (joined to project_databases →
// projects, customer-scoped). One join chain terminating at .limit(1), so a
// fake that returns the staged rows from limit() is enough; the WHERE/JOIN
// correctness is covered by the grant integration test against migrated Postgres.
function fakeJoinDb(rows: unknown[]): Db {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Db;
}

describe("resolveOAuthProjectId", () => {
  const subject = { clientId: "client-1", userId: "user-1", customerId: "cust-1" };

  it("returns the bound project id from the credential's grants", async () => {
    const db = fakeJoinDb([{ projectId: "conn-7" }]);
    expect(await resolveOAuthProjectId(db, subject)).toBe("conn-7");
  });

  it("returns null when the credential has no grants (unbound → caller 403s)", async () => {
    const db = fakeJoinDb([]);
    expect(await resolveOAuthProjectId(db, subject)).toBeNull();
  });
});

describe("resolveSoleProjectId — self-host generic-URL fallback", () => {
  it("returns the project id when the customer owns exactly one", async () => {
    const db = fakeJoinDb([{ id: "conn-1" }]);
    expect(await resolveSoleProjectId(db, "cust-1")).toBe("conn-1");
  });

  it("returns null when the customer owns none", async () => {
    const db = fakeJoinDb([]);
    expect(await resolveSoleProjectId(db, "cust-1")).toBeNull();
  });

  it("returns null when several projects exist (ambiguous)", async () => {
    const db = fakeJoinDb([{ id: "conn-1" }, { id: "conn-2" }]);
    expect(await resolveSoleProjectId(db, "cust-1")).toBeNull();
  });
});
