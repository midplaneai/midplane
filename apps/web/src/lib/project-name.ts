// Pure helpers for the user-supplied project label. Lives separately from
// lib/projects.ts so client components can import MAX_PROJECT_NAME_LENGTH
// without dragging the Drizzle/postgres server module into the client bundle.

export const MAX_PROJECT_NAME_LENGTH = 60;

// Trim whitespace and clamp length so a single project-name doesn't blow
// up the dashboard layout. Empty strings collapse to null so the column has
// one canonical "no name" representation.
export function normalizeName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_PROJECT_NAME_LENGTH);
}

// The agent-facing database ALIAS grammar — the string the agent uses to
// address a database. Mirror of the OSS engine's DB_NAME_RE, so a name
// validated here also parses engine-side without a round-trip: a leading
// lowercase letter, then up to 31 more of [a-z0-9_-] (1–32 chars total).
// This is NOT the cosmetic project label (that's normalizeName above and
// allows any string) — it's a machine identifier, so it's strict.
//
// Pure + dependency-free so the client form can slugify/preview with the
// exact same rule the server enforces (no Drizzle/postgres in the bundle).
export const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidDatabaseName(s: unknown): s is string {
  return typeof s === "string" && DB_NAME_RE.test(s);
}

// Coerce arbitrary user input into a valid database alias: lowercase,
// collapse illegal runs to a single "-", drop leading non-letters (the
// grammar needs a leading letter), clamp to 32, and trim a trailing
// separator. Returns "" when nothing valid survives (e.g. "123", "  ") —
// callers treat empty as "no alias supplied" and fall back to the DSN's
// database name. Shared by the create form (live preview) and
// deriveDatabaseAlias (DSN path) so both produce identical slugs.
export function slugifyDatabaseName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/[-_]+$/, "");
}
