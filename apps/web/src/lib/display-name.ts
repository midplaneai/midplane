// Bound and clean `user.name` — the display name shown in the sidebar, the
// account page, the members list, and (via esc()) transactional email.
//
// This is storage hygiene, NOT the XSS boundary. Every render site already
// escapes: React escapes JSX text children, and the hand-written email
// templates go through esc() in lib/email.ts. We deliberately do NOT reject
// `<`/`>` here — blacklisting markup characters rejects legitimate names for no
// security gain, and worse, it invites the assumption that stored values are
// render-safe. That assumption is exactly what turns one missed escape into
// stored XSS. Bound the field, strip what breaks layout, keep escaping at the
// sink.
//
// Applied in the `user` database hooks (lib/auth.ts) rather than at the signup
// form, because the form is only one of the paths that writes this column:
// Google OAuth takes the name straight from the provider profile, and Better
// Auth exposes /update-user by default, so a form-only cap holds on neither.

/** Max stored display-name length. Comfortably above any real name (including
 *  scripts where full names run long) and below the point where a name can
 *  bloat a row or blow out the sidebar / members list. */
export const MAX_DISPLAY_NAME_LENGTH = 256;

// C0/C1 control characters plus the bidirectional formatting characters. Built
// from escape strings rather than a regex literal so the source file carries no
// raw control bytes. The bidi set matters beyond tidiness: the overrides and
// isolates let a name visually reorder the text rendered *around* it, so a
// display name can scramble the label next to it in the members list.
const CONTROL_AND_BIDI = new RegExp(
  "[" +
    "\\u0000-\\u001F" + // C0 controls
    "\\u007F-\\u009F" + // DEL + C1 controls
    "\\u200E\\u200F" + // LRM / RLM
    "\\u202A-\\u202E" + // LRE / RLE / PDF / LRO / RLO
    "\\u2066-\\u2069" + // LRI / RLI / FSI / PDI
    "]",
  "g",
);

/** Normalize a display name for storage: strip control/bidi characters, trim,
 *  and truncate to MAX_DISPLAY_NAME_LENGTH. Returns the input unchanged when
 *  it's already clean. Truncation splits by code point, so it can't leave a
 *  lone surrogate behind (a half-emoji that some consumers reject as invalid
 *  UTF-8). */
export function normalizeDisplayName(name: string): string {
  const cleaned = name.replace(CONTROL_AND_BIDI, "").trim();
  const points = Array.from(cleaned);
  if (points.length <= MAX_DISPLAY_NAME_LENGTH) return cleaned;
  return points.slice(0, MAX_DISPLAY_NAME_LENGTH).join("").trim();
}
