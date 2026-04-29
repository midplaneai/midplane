// Adversarial corpus — execution side-effects beyond DML.
//
// V1 reads "writes" broadly: NOTIFY publishes to Postgres pubsub,
// LISTEN/UNLISTEN mutate session state, LOCK acquires durable
// transaction-scoped locks, CALL/EXECUTE invoke stored procedures,
// COPY moves data on the server filesystem. All of these can have
// side effects outside the read-only contract, so all of them deny
// via writes_require_approval.
//
// Known limitation (documented, not patched at V1): SELECT-wrapped
// admin-function calls like `SELECT pg_terminate_backend(123)` parse as
// a SelectStmt with a FuncCall and are NOT denied. AST-level write
// detection cannot tell side-effecting functions from pure ones without
// a denylist. V1.5 will introduce a function-side-effects denylist.

import { describe, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow } from "./_helpers.ts";

const WRITES = PolicyRule.WRITES_REQUIRE_APPROVAL;

describe("adversarial/exec-side-effects: stored procedure / prepared", () => {
  test("CALL my_proc() → deny (CallStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CALL my_proc()", WRITES);
  });

  test("EXECUTE my_prepared → deny (ExecuteStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "EXECUTE my_prepared", WRITES);
  });

  test("PREPARE my_p AS SELECT 1 → currently allow (V1 known gap)", async () => {
    // PrepareStmt registers a prepared statement on the session — a
    // session-state mutation, not in V1 WRITE_KINDS. Pinned as allow so
    // a tightening in V1.5 (function-side-effects denylist + session
    // tracking) surfaces as a deliberate test flip, not a silent change.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "PREPARE my_p AS SELECT 1");
  });

  test("DEALLOCATE my_p → currently allow (V1 known gap)", async () => {
    // DeallocateStmt — symmetric to PREPARE. Same V1 gap.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "DEALLOCATE my_p");
  });
});

describe("adversarial/exec-side-effects: NOTIFY/LISTEN/UNLISTEN/LOCK", () => {
  // These were tightened in this PR — added to WRITE_KINDS so the four
  // categories are surfaced through the same DENY path as DML.
  test("NOTIFY ch, 'msg' → deny (publishes pubsub event)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "NOTIFY ch, 'msg'", WRITES);
  });

  test("LISTEN ch → deny (mutates session subscription state)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "LISTEN ch", WRITES);
  });

  test("UNLISTEN ch → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "UNLISTEN ch", WRITES);
  });

  test("UNLISTEN * → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "UNLISTEN *", WRITES);
  });

  test("LOCK TABLE users IN ACCESS EXCLUSIVE MODE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "LOCK TABLE users IN ACCESS EXCLUSIVE MODE",
      WRITES,
    );
  });

  test("LOCK TABLE users (default mode) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "LOCK TABLE users", WRITES);
  });
});

describe("adversarial/exec-side-effects: COPY", () => {
  test("COPY t FROM '/etc/passwd' → deny (server-side filesystem read)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t FROM '/etc/passwd'", WRITES);
  });

  test("COPY t TO '/tmp/leak' → deny (server-side filesystem write)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t TO '/tmp/leak'", WRITES);
  });

  test("COPY t FROM STDIN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t FROM STDIN", WRITES);
  });

  test("COPY (SELECT * FROM users) TO '/tmp/dump' → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "COPY (SELECT * FROM users) TO '/tmp/dump'",
      WRITES,
    );
  });
});

describe("adversarial/exec-side-effects: transaction control", () => {
  test("BEGIN → currently allow (V1 known gap)", async () => {
    // TransactionStmt is in STATEMENT_KINDS but not WRITE_KINDS. V1 doesn't
    // model session-level transaction state; the executor commits per query.
    // BEGIN by itself is a no-op for our pipeline — documented gap.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "BEGIN");
  });

  test("VACUUM → currently allow (V1 known gap)", async () => {
    // VacuumStmt isn't in WRITE_KINDS at V1. Vacuum has performance
    // side effects (locks, IO) but no data mutation. Documented gap;
    // V1.5 will likely tighten this.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "VACUUM users");
  });
});

describe("adversarial/exec-side-effects: SELECT-wrapped admin functions", () => {
  // These are documented V1 gaps. The corpus surfaces them so a buyer
  // reading the public artifact sees exactly what V1 does and does not
  // catch. V1.5 introduces a side-effecting-function denylist.
  test("SELECT pg_terminate_backend(123) → currently allow (V1 gap)", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT pg_terminate_backend(123)");
  });

  test("SELECT pg_cancel_backend(123) → currently allow (V1 gap)", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT pg_cancel_backend(123)");
  });

  test("SELECT lo_unlink(1) → currently allow (V1 gap)", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT lo_unlink(1)");
  });
});
