// Simulation and gateway agree on the whole corpus (M5), first layer. The
// gateway evaluates with the catalog it read; the cloud simulates with the
// copy the gateway sent: redacted, serialized, and validated by the protocol
// schema on arrival. Every evaluation must come out identical, down to the
// rewritten statement and the denial's reason.

import { loadCorpus } from "@midplane/corpus";
import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
} from "@midplane/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluate,
  loadParser,
  redactCatalog,
  unredactedDefinitions,
} from "../src/index.ts";

const corpus = loadCorpus();

beforeAll(async () => {
  await loadParser();
});

const sent = new Map<CatalogSnapshot, CatalogSnapshot>();

/** The catalog as the cloud stores it after a gateway's upload. */
function asSent(catalog: CatalogSnapshot): CatalogSnapshot {
  let out = sent.get(catalog);
  if (!out) {
    const body = JSON.stringify(redactCatalog(catalog).catalog);
    out = CatalogSnapshotSchema.parse(JSON.parse(body));
    sent.set(catalog, out);
  }
  return out;
}

describe("the cloud's redacted catalog gives the gateway's evaluation", () => {
  it.each(corpus.map((c) => [`${c.id} ${c.name}`, c] as const))(
    "%s",
    (_, c) => {
      const gateway = evaluate(c.input);
      const cloud = evaluate({ ...c.input, catalog: asSent(c.input.catalog) });
      expect(cloud).toEqual(gateway);
    },
  );
});

it("puts redacted views to work in enough cases to mean something", () => {
  // Cases that name a view whose definition held a literal: the redaction
  // really changed what the simulator traced through.
  let through = 0;
  for (const c of corpus) {
    const views = new Set(unredactedDefinitions(c.input.catalog));
    const tables = evaluate(c.input).effects.tables;
    if (tables.some((t) => views.has(t))) through++;
  }
  expect(through).toBeGreaterThanOrEqual(25);
});
