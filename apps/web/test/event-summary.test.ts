// eventSummary / policyReloadSummary — the one-line prose the audit list
// (and the CSV/JSON export) renders in the SQL column for non-query rows.
// Both are pure functions that happen to live in status-badge.tsx; the JSX
// around them (StatusBadge) is exercised by the live E2E, not here.
//
// The load-bearing branch is GUARDRAILS_CHANGED: the payload carries the
// RESULTING flags and the summary must say where each landed — an opt-out
// ("allowed") is exactly the line an audit reviewer is scanning for.

import { describe, expect, it } from "vitest";

import {
  eventSummary,
  policyReloadSummary,
} from "../src/components/audit/status-badge.tsx";

describe("eventSummary — GUARDRAILS_CHANGED rows", () => {
  it("says both nets hold when both flags are on", () => {
    const s = eventSummary("POLICY_RELOAD", {
      project_id: "conn-1",
      database_name: "main",
      guardrails: { block_unqualified_dml: true, block_ddl: true },
    });
    expect(s).toBe(
      "guardrails updated — DML with no WHERE blocked, DDL blocked",
    );
  });

  it("surfaces an opt-out as 'allowed' — the line a reviewer cares about", () => {
    const s = eventSummary("POLICY_RELOAD", {
      guardrails: { block_unqualified_dml: true, block_ddl: false },
    });
    expect(s).toBe(
      "guardrails updated — DML with no WHERE blocked, DDL allowed",
    );
    expect(
      eventSummary("POLICY_RELOAD", {
        guardrails: { block_unqualified_dml: false, block_ddl: false },
      }),
    ).toBe("guardrails updated — DML with no WHERE allowed, DDL allowed");
  });

  it("reads a missing flag as blocked (only explicit false means opted out)", () => {
    // Mirrors the default-ON posture everywhere else: absent ⇒ protected.
    expect(eventSummary("POLICY_RELOAD", { guardrails: {} })).toBe(
      "guardrails updated — DML with no WHERE blocked, DDL blocked",
    );
  });

  it("does not hijack other config rows — no guardrails key falls through to policyReloadSummary", () => {
    const s = eventSummary("POLICY_RELOAD", {
      sections_changed: ["table_access"],
      databases_changed: ["main"],
    });
    expect(s).toBe("table_access updated on main");
  });

  it("an engine 0.9.0 POLICY_RELOADED payload (guardrails posture ALWAYS present) renders as a reload, not a cloud guardrails edit", () => {
    // Since OSS 0.9.0 every hot-swap payload carries a `guardrails`
    // object (engine-factory.ts) alongside sections_changed — the
    // bare-key sniff alone would relabel every engine reload row.
    const s = eventSummary("POLICY_RELOAD", {
      sections_changed: ["table_access"],
      databases_changed: ["main"],
      // Engine shape is the resolved GuardrailsSpec (camelCase) — the
      // shape difference must not matter; sections_changed decides.
      guardrails: { blockUnqualifiedDml: true, blockDdl: true },
    });
    expect(s).toBe("table_access updated on main");
  });

  it("pause/resume markers still win over the guardrails branch ordering", () => {
    expect(eventSummary("POLICY_RELOAD", { action: "paused" })).toBe(
      "project paused by owner",
    );
  });

  it("returns empty for query-outcome statuses (they render SQL, not prose)", () => {
    expect(eventSummary("ALLOWED", { guardrails: {} })).toBe("");
    expect(eventSummary("DENIED", null)).toBe("");
  });
});

describe("policyReloadSummary — engine 0.9.0 section names", () => {
  it("passes section names through verbatim (guardrails must not collapse to table_access)", () => {
    const s = policyReloadSummary({
      sections_changed: ["table_access", "guardrails"],
      databases_changed: ["main"],
    });
    expect(s).toBe("table_access + guardrails updated on main");
  });

  it("falls back to the generic label when the payload predates sections_changed", () => {
    expect(policyReloadSummary(null)).toBe("Policy hot-swap reload");
    expect(policyReloadSummary({ sections_changed: [] })).toBe(
      "Policy hot-swap reload",
    );
  });
});
