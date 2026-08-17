// Guards for two UI affordances that are invisible to the node-env suite but
// are exactly what a user feels:
//
//   1. Every DSN paste form answers a bad connection string from the SAME
//      checker (lib/dsn-format), on blur — not after a probe round trip and
//      not with the raw "invalid body" envelope the routes used to return.
//   2. Every button whose form runs a slow provisioning action shows progress.
//      A plain <Button type="submit"> stays lit and clickable while the org is
//      created / the machine is torn down, which reads as "nothing happened"
//      and gets double-clicked.
//
// Source-level assertions, same idiom as turnstile-widget.test.ts: these are
// client components in a node-environment vitest run (no DOM, no
// testing-library), and the failure mode is structural — a missing wire-up —
// not branch logic we can drive with inputs.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Every surface where a user pastes a raw connection string.
const PASTE_FORMS = [
  "../src/components/projects/new-project-form.tsx",
  "../src/components/dashboard/add-database-form.tsx",
  "../src/components/rotate-project-form.tsx",
];

// Forms whose action provisions or tears something down: workspace setup
// (org + customer row + region cookie + welcome mail), project create, sample
// provisioning, pause/resume (engine session teardown), delete (machine +
// token revocation).
const SLOW_ACTION_FORMS = [
  "../src/app/signup/page.tsx",
  "../src/components/projects/new-project-form.tsx",
  "../src/components/projects/sample-project-button.tsx",
  "../src/components/projects/pause-project-button.tsx",
  "../src/components/projects/delete-database-button.tsx",
  "../src/components/dashboard/project-service-control.tsx",
  "../src/components/delete-project-button.tsx",
];

describe("DSN paste forms", () => {
  for (const rel of PASTE_FORMS) {
    it(`${rel.split("/").pop()} validates through lib/dsn-format`, async () => {
      const src = await source(rel);
      expect(src).toContain("describeDsnProblem");
      // The old inline checks (a startsWith pair, a local regex) are what let
      // the three surfaces drift apart in the first place.
      expect(src).not.toContain('startsWith("postgres://")');
    });

    it(`${rel.split("/").pop()} answers on blur, not only on submit`, async () => {
      const src = await source(rel);
      expect(src).toMatch(/onBlur/);
    });
  }

  it("the shared status block renders the remedy, not just the message", async () => {
    const src = await source("../src/components/projects/test-dsn-button.tsx");
    // hint is the "percent-encode the @" half of the answer — dropping it
    // leaves the user with a diagnosis and no fix.
    expect(src).toContain("hint");
    expect(src).toContain("Alert");
    // Format problems must not cost a probe round trip (or a slot in the
    // shared per-customer ping budget).
    expect(src).toContain("describeDsnProblem");
  });
});

describe("slow server-action buttons", () => {
  for (const rel of SLOW_ACTION_FORMS) {
    it(`${rel.split("/").pop()} shows progress while the action runs`, async () => {
      const src = await source(rel);
      expect(src).toContain("SubmitButton");
      // AlertDialogAction is a Dialog.Close: it dismissed the confirm the
      // instant it was clicked, before the action had even started, so the
      // teardown ran with no indication anywhere on screen.
      expect(src).not.toContain("<AlertDialogAction");
    });
  }

  it("SubmitButton disables itself and announces busy while pending", async () => {
    const src = await source("../src/components/ui/submit-button.tsx");
    expect(src).toContain("useFormStatus");
    expect(src).toContain("disabled={disabled || pending}");
    expect(src).toContain("aria-busy");
    // The spinner is the one motion DESIGN.md ships by default; keep it
    // reduced-motion safe.
    expect(src).toContain("motion-safe:animate-spin");
  });
});
