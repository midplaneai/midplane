// Unit coverage for the audit-list statement-kind classifier. Coarse by
// design (read/write/ddl/other); the OSS AST parser owns the authoritative
// per-statement type. These cases pin the buckets the list table renders.

import { describe, expect, it } from "vitest";

import { classifySql } from "../src/lib/sql-kind.ts";

describe("classifySql", () => {
  it("returns null for empty / nullish input", () => {
    expect(classifySql(null)).toBeNull();
    expect(classifySql(undefined)).toBeNull();
    expect(classifySql("")).toBeNull();
    expect(classifySql("   ")).toBeNull();
  });

  it("classifies row-returning + introspection as read", () => {
    expect(classifySql("SELECT * FROM customers")).toBe("read");
    expect(classifySql("select count(*) from t")).toBe("read");
    expect(classifySql("SHOW search_path")).toBe("read");
    expect(classifySql("EXPLAIN ANALYZE SELECT 1")).toBe("read");
    expect(classifySql("TABLE customers")).toBe("read");
    expect(classifySql("VALUES (1), (2)")).toBe("read");
  });

  it("classifies DML as write", () => {
    expect(classifySql("INSERT INTO t (a) VALUES (1)")).toBe("write");
    expect(classifySql("UPDATE t SET a = 1 WHERE id = 2")).toBe("write");
    expect(classifySql("DELETE FROM t WHERE id = 2")).toBe("write");
    expect(classifySql("merge into t using s on (t.id=s.id)")).toBe("write");
  });

  it("classifies schema / privilege / maintenance as ddl", () => {
    expect(classifySql("CREATE TABLE t (id int)")).toBe("ddl");
    expect(classifySql("ALTER TABLE t ADD COLUMN b int")).toBe("ddl");
    expect(classifySql("DROP TABLE t")).toBe("ddl");
    expect(classifySql("TRUNCATE t")).toBe("ddl");
    expect(classifySql("GRANT SELECT ON t TO bob")).toBe("ddl");
    expect(classifySql("REVOKE ALL ON t FROM bob")).toBe("ddl");
    expect(classifySql("VACUUM ANALYZE t")).toBe("ddl");
  });

  it("resolves a writing CTE (WITH … DELETE) to write, plain WITH … SELECT to read", () => {
    expect(
      classifySql("WITH x AS (SELECT id FROM t) DELETE FROM u WHERE id IN (SELECT id FROM x)"),
    ).toBe("write");
    expect(classifySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("read");
  });

  it("strips a leading intent comment before classifying", () => {
    expect(
      classifySql('/* midplane:intent="purge" */ DELETE FROM t WHERE id = 1'),
    ).toBe("write");
    expect(classifySql("-- a note\nSELECT 1")).toBe("read");
  });

  it("unwraps leading parens", () => {
    expect(classifySql("(SELECT 1) UNION (SELECT 2)")).toBe("read");
  });

  it("buckets unrecognized leading keywords as other", () => {
    expect(classifySql("BEGIN")).toBe("other");
    expect(classifySql("SET search_path = public")).toBe("other");
  });
});
