// Replays the whole corpus through evaluate(). Each case checks only the
// fields its expectation names.

import { loadCorpus } from "@midplane/corpus";
import { beforeAll, describe, expect, it } from "vitest";
import { type Evaluation, evaluate, loadParser } from "../src/index.ts";

const corpus = loadCorpus();

beforeAll(async () => {
  await loadParser();
});

function sourcesOf(e: Evaluation) {
  if (e.verdict === "deny") return undefined;
  return e.plan.outputColumns.map((c) => ({
    name: c.name,
    sources: c.sources.map((s) => `${s.schema}.${s.table}.${s.column}`),
  }));
}

describe("corpus", () => {
  it.each(corpus.map((c) => [`${c.id} ${c.name}`, c] as const))(
    "%s",
    (_, c) => {
      const got = evaluate(c.input);
      const want = c.expect;
      const summary =
        got.verdict === "deny"
          ? `deny/${got.rule}: ${got.reason}`
          : got.verdict;
      expect(got.verdict, summary).toBe(want.verdict);
      if (want.rule)
        expect(got.verdict === "deny" ? got.rule : null, summary).toBe(
          want.rule,
        );
      if (want.reason_includes) {
        expect(got.verdict === "deny" ? got.reason : "").toContain(
          want.reason_includes,
        );
      }
      if (want.class)
        expect(got.verdict === "hold" ? got.class : null).toBe(want.class);
      if (want.cause)
        expect(got.verdict === "hold" ? got.cause : null).toBe(want.cause);
      if (got.verdict !== "deny") {
        const plan = got.plan;
        if (want.statement !== undefined)
          expect(plan.statement).toBe(want.statement);
        for (const s of want.statement_includes ?? [])
          expect(plan.statement).toContain(s);
        for (const s of want.statement_excludes ?? [])
          expect(plan.statement).not.toContain(s);
        if (want.read_only !== undefined)
          expect(plan.readOnly).toBe(want.read_only);
        if (want.output) expect(sourcesOf(got)).toEqual(want.output);
      }
      if (want.taints !== undefined)
        expect(got.effects.taints).toBe(want.taints);
      if (want.taint_sources)
        expect(
          got.effects.taintSources.map((t) => `${t.table}.${t.column}`),
        ).toEqual(want.taint_sources);
      if (want.depends_on_taint !== undefined)
        expect(got.effects.dependsOnTaint).toBe(want.depends_on_taint);
      if (want.reads_untrusted !== undefined)
        expect(got.effects.readsUntrusted).toBe(want.reads_untrusted);
      if (want.tables) expect(got.effects.tables).toEqual(want.tables);
      if (want.preview !== undefined) {
        const preview = got.verdict === "hold" ? got.preview : undefined;
        if (want.preview === null) expect(preview).toBeNull();
        else {
          expect(preview).toBeTruthy();
          if (want.preview.sql !== undefined)
            expect(preview?.sql).toBe(want.preview.sql);
          if (want.preview.exact !== undefined)
            expect(preview?.exact).toBe(want.preview.exact);
        }
      }
    },
  );
});
