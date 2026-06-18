// table_access — per-session read-only ceiling (ctx.scope_max_access).
//
// The cloud per-agent grant rides on EngineContext.scope_max_access (set from
// the X-Midplane-Scope header). "read" caps the session at read: a write the
// table_access POLICY would otherwise permit is denied. It only NARROWS — it
// never widens a table the policy denies, and reads are unaffected. Absent /
// "read_write" → no clamp (back-compat with every pre-scope session).

import { describe, expect, test } from "bun:test";

import { makeEngine, baseCtx } from "../_helpers.ts";
import type { EngineContext } from "../../src/engine.ts";

const POLICY = { default: "deny" as const, tables: { users: "read_write" as const } };

const ctxWith = (scope_max_access: EngineContext["scope_max_access"]): EngineContext => ({
  ...baseCtx,
  scope_max_access,
});

describe("table_access — scope_max_access read-only ceiling", () => {
  test('"read" ceiling denies a write the policy would allow', async () => {
    const { engine } = makeEngine({ tableAccess: POLICY });
    const d = await engine.handle({
      sql: "UPDATE users SET name = 'x' WHERE id = 1",
      ctx: ctxWith("read"),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("table_access");
      // Distinct scope message — NOT the "mark it read_write" policy message.
      expect(d.message).toContain("scoped to read-only");
      expect(d.message).not.toContain("MIDPLANE_POLICY_FILE");
    }
  });

  test('"read_write" ceiling leaves a policy-permitted write allowed', async () => {
    const { engine } = makeEngine({ tableAccess: POLICY });
    const d = await engine.handle({
      sql: "UPDATE users SET name = 'x' WHERE id = 1",
      ctx: ctxWith("read_write"),
    });
    expect(d.allowed).toBe(true);
  });

  test("no ceiling (undefined) is unchanged back-compat — write allowed", async () => {
    const { engine } = makeEngine({ tableAccess: POLICY });
    const d = await engine.handle({
      sql: "UPDATE users SET name = 'x' WHERE id = 1",
      ctx: ctxWith(undefined),
    });
    expect(d.allowed).toBe(true);
  });

  test('"read" ceiling never blocks reads', async () => {
    const { engine } = makeEngine({ tableAccess: POLICY });
    const d = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: ctxWith("read"),
    });
    expect(d.allowed).toBe(true);
  });

  test('a policy-denied write under a "read" ceiling reports the POLICY reason, not the scope one', async () => {
    // users is read-only in policy → the write is blocked by table_access
    // itself; the scope clamp only fires when the policy WOULD have allowed.
    const { engine } = makeEngine({
      tableAccess: { default: "deny", tables: { users: "read" } },
    });
    const d = await engine.handle({
      sql: "UPDATE users SET name = 'x' WHERE id = 1",
      ctx: ctxWith("read"),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("table_access");
      expect(d.message).toContain("not allowed by the table-access policy");
      expect(d.message).not.toContain("scoped to read-only");
    }
  });

  test("decide() (dry-run) reflects the same clamp as handle()", async () => {
    const { engine } = makeEngine({ tableAccess: POLICY });
    const preview = await engine.decide({
      sql: "UPDATE users SET name = 'x' WHERE id = 1",
      ctx: ctxWith("read"),
    });
    expect(preview.decision).toBe("DENY");
    expect(preview.reason).toBe("table_access");
  });
});
