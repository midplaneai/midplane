// Adversarial corpus — execution side-effects beyond DML.
//
// `table_access` reads "writes" broadly: NOTIFY publishes to Postgres
// pubsub, LISTEN/UNLISTEN mutate session state, LOCK acquires durable
// transaction-scoped locks, CALL/EXECUTE invoke stored procedures,
// COPY moves data on the server filesystem. None of these carry an
// extractable per-table target that the YAML can grant `read_write` to,
// so all of them deny under both legacy (no YAML) and any YAML config.
//
// The former known limitation — SELECT-wrapped admin-function calls like
// `SELECT pg_terminate_backend(123)` parsing as an ordinary read — is CLOSED.
// The `dangerous_function` rule is the function-side-effects denylist that
// section was waiting on, it ships in the MIT engine rather than Cloud, and it
// is always on. See src/policy/rules/dangerous-function.ts for what a name
// denylist can and cannot cover.

import { describe, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow } from "./_helpers.ts";

const TABLE_ACCESS = PolicyRule.TABLE_ACCESS;

describe("adversarial/exec-side-effects: stored procedure / prepared", () => {
  test("CALL my_proc() → deny (CallStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CALL my_proc()", TABLE_ACCESS);
  });

  test("EXECUTE my_prepared → deny (ExecuteStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "EXECUTE my_prepared", TABLE_ACCESS);
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
    await expectDeny(engine, baseCtx, "NOTIFY ch, 'msg'", TABLE_ACCESS);
  });

  test("LISTEN ch → deny (mutates session subscription state)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "LISTEN ch", TABLE_ACCESS);
  });

  test("UNLISTEN ch → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "UNLISTEN ch", TABLE_ACCESS);
  });

  test("UNLISTEN * → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "UNLISTEN *", TABLE_ACCESS);
  });

  test("LOCK TABLE users IN ACCESS EXCLUSIVE MODE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "LOCK TABLE users IN ACCESS EXCLUSIVE MODE",
      TABLE_ACCESS,
    );
  });

  test("LOCK TABLE users (default mode) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "LOCK TABLE users", TABLE_ACCESS);
  });
});

describe("adversarial/exec-side-effects: COPY", () => {
  test("COPY t FROM '/etc/passwd' → deny (server-side filesystem read)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t FROM '/etc/passwd'", TABLE_ACCESS);
  });

  test("COPY t TO '/tmp/leak' → deny (server-side filesystem write)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t TO '/tmp/leak'", TABLE_ACCESS);
  });

  test("COPY t FROM STDIN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "COPY t FROM STDIN", TABLE_ACCESS);
  });

  test("COPY (SELECT * FROM users) TO '/tmp/dump' → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "COPY (SELECT * FROM users) TO '/tmp/dump'",
      TABLE_ACCESS,
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
  // These WERE the documented V1 gap: a side-effecting function wrapped in a
  // SELECT parses as an ordinary read, and AST-level write detection cannot
  // tell it from a pure one without a denylist. That denylist now exists as the
  // `dangerous_function` rule, so all three deny — and they deny under the
  // DEFAULT harness config, because the rule is always on and takes no config.
  const DANGEROUS_FUNCTION = PolicyRule.DANGEROUS_FUNCTION;

  test("SELECT pg_terminate_backend(123) → deny (changes server state)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT pg_terminate_backend(123)",
      DANGEROUS_FUNCTION,
    );
  });

  test("SELECT pg_cancel_backend(123) → deny (changes server state)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT pg_cancel_backend(123)",
      DANGEROUS_FUNCTION,
    );
  });

  test("SELECT lo_unlink(1) → deny (a write disguised as a SELECT)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT lo_unlink(1)", DANGEROUS_FUNCTION);
  });

  test("SELECT pg_read_file('/etc/passwd') → deny (server-side file read)", async () => {
    // The vector reported privately against 0.19.0. COPY … FROM '/etc/passwd'
    // was already denied above; this is the same file access spelled as a
    // function, and it must reach the same verdict.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT pg_read_file('/etc/passwd')",
      DANGEROUS_FUNCTION,
    );
  });

  test("SELECT query_to_xml('SELECT * FROM users', …) → deny (reads a table via a string)", async () => {
    // The more severe sibling: core PostgreSQL, EXECUTE granted to PUBLIC, so
    // it needs no privileged role. Reads any table the connected role can see
    // without naming it, which is a table_access and tenant_scope bypass.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT query_to_xml('SELECT * FROM users', false, true, '')",
      DANGEROUS_FUNCTION,
    );
  });
});
