// dedupeSelections — the ownership + shape filter applied before grant rows
// land. The DB-touching helpers (setOAuthGrants / setTokenGrants) are exercised
// end-to-end by the grant integration test against a migrated Postgres; this
// covers the pure validation that decides what gets written.

import { describe, expect, it } from "vitest";

import { dedupeSelections } from "../src/lib/scope-grants.ts";

const owned = new Set(["cdb-1", "cdb-2"]);

describe("dedupeSelections", () => {
  it("keeps only owned databases (drops foreign / tampered ids)", () => {
    const out = dedupeSelections(
      [
        { connectionDatabaseId: "cdb-1", access: "read" },
        { connectionDatabaseId: "cdb-foreign", access: "write" },
      ],
      owned,
    );
    expect(out).toEqual([{ connectionDatabaseId: "cdb-1", access: "read" }]);
  });

  it("last selection wins for a duplicated DB", () => {
    const out = dedupeSelections(
      [
        { connectionDatabaseId: "cdb-1", access: "read" },
        { connectionDatabaseId: "cdb-1", access: "write" },
      ],
      owned,
    );
    expect(out).toEqual([{ connectionDatabaseId: "cdb-1", access: "write" }]);
  });

  it("drops entries with an invalid access value", () => {
    const out = dedupeSelections(
      [
        { connectionDatabaseId: "cdb-1", access: "read" },
        // @ts-expect-error — exercising a tampered submit
        { connectionDatabaseId: "cdb-2", access: "admin" },
      ],
      owned,
    );
    expect(out).toEqual([{ connectionDatabaseId: "cdb-1", access: "read" }]);
  });

  it("empty in → empty out (a deny-all consent)", () => {
    expect(dedupeSelections([], owned)).toEqual([]);
  });
});
