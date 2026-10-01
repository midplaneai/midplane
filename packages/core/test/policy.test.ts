import { expect, it } from "vitest";
import {
  CORE_FEATURES,
  requiredFeatures,
  validatePolicy,
} from "../src/index.ts";

it("accepts a policy whose features this core implements", () => {
  const v = validatePolicy({ requires_features: ["masks", "labels"] });
  expect(v.ok).toBe(true);
});

it("refuses a policy that needs a feature this core lacks", () => {
  const v = validatePolicy({ requires_features: ["masks", "tenant_filters"] });
  expect(v).toEqual({
    ok: false,
    errors: ["requires features this engine lacks: tenant_filters"],
  });
});

it("reports schema errors with their path", () => {
  const v = validatePolicy({ writes: { row_changes: "sometimes" } });
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.errors[0]).toMatch(/^writes\.row_changes: /);
});

it("requires each section a policy names, even empty, plus requires_features", () => {
  expect(
    requiredFeatures({
      table_access: { default: "read" },
      masks: {},
      role: "agent",
      limits: { statement_timeout_ms: 1000 },
      requires_features: ["labels", "masks"],
    }),
  ).toEqual(["labels", "masks", "table_access"]);
});

it("requires nothing of the empty policy, and names a section it doesn't know", () => {
  expect(requiredFeatures({})).toEqual([]);
  expect(requiredFeatures({ approvals: { channel: "slack" } })).toEqual([
    "approvals",
  ]);
  expect(requiredFeatures(null)).toEqual([]);
  expect(requiredFeatures(["masks"])).toEqual([]);
});

it("requires only features every current gateway reports for any valid policy", () => {
  const all = {
    requires_features: ["masks"],
    table_access: {},
    writes: {},
    masks: {},
    labels: {},
    role: "r",
    limits: {},
  };
  expect(validatePolicy(all).ok).toBe(true);
  for (const f of requiredFeatures(all))
    expect(CORE_FEATURES.has(f)).toBe(true);
});
