import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { approvalKey } from "../src/index.ts";

// The scheme the old control plane used (apps/web/src/lib/approvals.ts
// grantKeyFor), with the grant replacing the token id. Node's hash is the
// reference; the core's must match it byte for byte.
function reference(parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(String(Buffer.byteLength(part, "utf8")));
    h.update(":");
    h.update(part, "utf8");
    h.update("|");
  }
  return h.digest("hex");
}

const base = {
  databaseId: "db_1",
  sql: "DELETE FROM orders WHERE id < 100",
  intent: "clean up test orders",
  grantId: "grant_1",
};

it("matches the reference scheme, including multibyte text", () => {
  for (const p of [
    base,
    { ...base, sql: "UPDATE t SET name = 'Zoë 🙂' WHERE id = 1" },
  ]) {
    expect(approvalKey(p)).toBe(
      reference([p.databaseId, p.sql, p.intent, p.grantId]),
    );
  }
});

it("binds every field: one changed byte is a different approval", () => {
  const key = approvalKey(base);
  expect(
    approvalKey({ ...base, sql: "DELETE FROM orders WHERE id < 1000" }),
  ).not.toBe(key);
  expect(approvalKey({ ...base, intent: "clean up test orders." })).not.toBe(
    key,
  );
  expect(approvalKey({ ...base, databaseId: "db_2" })).not.toBe(key);
  expect(approvalKey({ ...base, grantId: "grant_2" })).not.toBe(key);
});

it("can't be forged by moving bytes between fields", () => {
  expect(approvalKey({ ...base, sql: "ab", intent: "c" })).not.toBe(
    approvalKey({ ...base, sql: "a", intent: "bc" }),
  );
});
