import { loadCorpus } from "@midplane/corpus";
import { beforeAll, expect, it } from "vitest";
import { evaluate, loadParser, MAX_SQL_BYTES } from "../src/index.ts";

beforeAll(async () => {
  await loadParser();
});

const input = loadCorpus().find((c) => c.id.startsWith("resolve#"))?.input;
if (!input) throw new Error("resolve fixtures missing");

// Size cases can't live in JSON fixtures, so they live here.
it("caps statements at 1 MiB of UTF-8, not of characters", () => {
  const pad = (n: number, ch: string) => `SELECT 1 /* ${ch.repeat(n)} */`;
  const under = pad(MAX_SQL_BYTES - 64, "a");
  expect(evaluate({ ...input, sql: under }).verdict).toBe("allow");
  const over = pad(MAX_SQL_BYTES, "a");
  expect(evaluate({ ...input, sql: over })).toMatchObject({
    verdict: "deny",
    rule: "parse_error",
  });
  // Fewer characters than the cap, more bytes: each é is two bytes.
  const multibyte = pad(Math.ceil(MAX_SQL_BYTES / 2) + 16, "é");
  expect(multibyte.length).toBeLessThan(MAX_SQL_BYTES);
  expect(evaluate({ ...input, sql: multibyte })).toMatchObject({
    verdict: "deny",
    rule: "parse_error",
  });
});
