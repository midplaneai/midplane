// Display-name normalization (lib/display-name.ts), applied in the `user`
// database hooks. Prompted by a scanner signup that planted a tag-breakout XSS
// probe in `user.name`; the payload was inert (every render site escapes), so
// this pins the hygiene contract, NOT an escaping boundary — see the
// "keeps markup characters" case, which is deliberate.

import { describe, expect, it } from "vitest";

import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "../src/lib/display-name.ts";

const NUL = String.fromCharCode(0x00);
const RLO = String.fromCharCode(0x202e); // right-to-left override
const LRM = String.fromCharCode(0x200e); // left-to-right mark

describe("normalizeDisplayName", () => {
  it("leaves an ordinary name untouched", () => {
    expect(normalizeDisplayName("Dana Scully")).toBe("Dana Scully");
    expect(normalizeDisplayName("Zoë Ödegård")).toBe("Zoë Ödegård");
    expect(normalizeDisplayName("日本語の名前")).toBe("日本語の名前");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDisplayName("  Dana  ")).toBe("Dana");
    expect(normalizeDisplayName("\n\tDana\n")).toBe("Dana");
  });

  it("KEEPS markup characters — escaping is the sink's job, not storage's", () => {
    // Rejecting `<`/`>` here would be input blacklisting: it buys nothing
    // (React escapes JSX text; email goes through esc()) and it would reject
    // legitimate names. Storing the raw value is the intended behavior.
    const probe = '<script src="https://evil.example/x.js"></script>';
    expect(normalizeDisplayName(probe)).toBe(probe);
    expect(normalizeDisplayName("O'Brien & Sons")).toBe("O'Brien & Sons");
  });

  it("strips control characters", () => {
    expect(normalizeDisplayName(`Da${NUL}na`)).toBe("Dana");
    expect(normalizeDisplayName(`Dana${String.fromCharCode(0x7f)}`)).toBe(
      "Dana",
    );
  });

  it("strips bidi controls that would reorder surrounding text", () => {
    expect(normalizeDisplayName(`Dana${RLO}evil`)).toBe("Danaevil");
    expect(normalizeDisplayName(`${LRM}Dana`)).toBe("Dana");
  });

  it("truncates to the cap", () => {
    expect(normalizeDisplayName("a".repeat(5000))).toHaveLength(
      MAX_DISPLAY_NAME_LENGTH,
    );
    // Under the cap is untouched.
    const ok = "a".repeat(MAX_DISPLAY_NAME_LENGTH);
    expect(normalizeDisplayName(ok)).toBe(ok);
  });

  it("truncates by code point, never leaving a lone surrogate", () => {
    // Slicing a UTF-16 string mid-emoji yields an unpaired surrogate, which
    // some consumers reject as invalid UTF-8. Array.from splits by code point.
    const out = normalizeDisplayName("👩‍🚀".repeat(400));
    expect(out).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("handles an empty / whitespace-only name", () => {
    expect(normalizeDisplayName("")).toBe("");
    expect(normalizeDisplayName("   ")).toBe("");
  });
});
