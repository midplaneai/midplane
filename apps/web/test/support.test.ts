// Unit coverage for lib/support.ts — the support-channel constants and the
// supportMailto builder used by the help links, the error surfaces
// (error.tsx / global-error.tsx / not-found.tsx), and the billing error copy.

import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL, supportMailto } from "../src/lib/support.ts";

describe("supportMailto", () => {
  it("bare mailto without args", () => {
    expect(supportMailto()).toBe(`mailto:${SUPPORT_EMAIL}`);
    expect(supportMailto()).toBe("mailto:support@midplane.ai");
    expect(supportMailto({})).toBe("mailto:support@midplane.ai");
  });

  it("encodes subject spaces as %20, not + (mail clients don't decode +)", () => {
    expect(supportMailto({ subject: "Billing problem" })).toBe(
      "mailto:support@midplane.ai?subject=Billing%20problem",
    );
    expect(supportMailto({ subject: "Billing problem" })).not.toContain("+");
  });

  it("encodes query-breaking characters and newlines; joins subject & body with &", () => {
    // The error pages pass multi-line bodies (ref/host/path/time block) and
    // subjects that can carry parens/ampersands — none of it may leak into the
    // mailto query structure unescaped.
    expect(
      supportMailto({ subject: "A & B?", body: "line one\nline two" }),
    ).toBe(
      "mailto:support@midplane.ai?subject=A%20%26%20B%3F&body=line%20one%0Aline%20two",
    );
  });

  it("omits empty-string subject/body instead of emitting dangling params", () => {
    expect(supportMailto({ subject: "", body: "" })).toBe(
      "mailto:support@midplane.ai",
    );
    expect(supportMailto({ body: "hi" })).toBe(
      "mailto:support@midplane.ai?body=hi",
    );
  });
});
