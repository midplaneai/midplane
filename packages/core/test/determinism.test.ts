// Invariant 13: the core is pure. The same input gives the same evaluation,
// whatever ran before it, so the whole corpus is evaluated twice, the second
// time in reverse order, and must match byte for byte.

import { loadCorpus } from "@midplane/corpus";
import { beforeAll, expect, it } from "vitest";
import { evaluate, loadParser } from "../src/index.ts";

beforeAll(async () => {
  await loadParser();
});

it("evaluates the corpus identically twice, in either order", () => {
  const corpus = loadCorpus();
  const first = corpus.map((c) => JSON.stringify(evaluate(c.input)));
  const second = [...corpus]
    .reverse()
    .map((c) => JSON.stringify(evaluate(c.input)))
    .reverse();
  expect(second).toEqual(first);
});
