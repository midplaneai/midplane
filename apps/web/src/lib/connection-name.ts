// Pure helpers for the user-supplied connection label. Lives separately from
// lib/connections.ts so client components can import MAX_CONNECTION_NAME_LENGTH
// without dragging the Drizzle/postgres server module into the client bundle.

export const MAX_CONNECTION_NAME_LENGTH = 60;

// Trim whitespace and clamp length so a single connection-name doesn't blow
// up the dashboard layout. Empty strings collapse to null so the column has
// one canonical "no name" representation.
export function normalizeName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_CONNECTION_NAME_LENGTH);
}
