// Suggest a default workspace/organization name at signup, so we don't name an
// org after the email local part ("test@…" → an org literally called "test").
// Corporate email → the company derived from the domain; generic provider
// (gmail, outlook, …), where the domain says nothing about a company → the
// person's name. Always a suggestion — the signup form prefills it, editable.

// Free / generic email providers: a signup from one of these has no company to
// derive a name from, so fall back to the person's name.
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  "mail.com",
  "tutanota.com",
]);

// Second-level public suffixes to skip when picking the company label, so
// "acme.co.uk" → "acme", not "co".
const SECOND_LEVEL_SUFFIXES = new Set([
  "co",
  "com",
  "org",
  "net",
  "ac",
  "gov",
  "edu",
]);

// The registrable company label of a domain: the label before the TLD (and
// before a second-level suffix like .co.uk). "mail.acme.com" → "acme".
function registrableLabel(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  let i = parts.length - 2;
  if (SECOND_LEVEL_SUFFIXES.has(parts[i] ?? "") && i - 1 >= 0) i -= 1;
  return parts[i] ?? "";
}

function titleCase(s: string): string {
  return s
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Suggest a default workspace name. Non-empty. Editable on the signup form —
 *  this is just the prefill. */
export function suggestWorkspaceName(
  email: string,
  name?: string | null,
): string {
  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : "";
  if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
    const label = registrableLabel(domain);
    if (label) return titleCase(label);
  }
  const person = name?.trim() || local;
  return `${person}'s workspace`;
}

/** Slugify a workspace name for the org slug (lowercase, alphanumeric +
 *  hyphens). May be empty when the input has no usable characters — callers
 *  add a uniqueness suffix and an "org" fallback. */
export function slugifyWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Max workspace-name length (shared by the input + validation). */
export const MAX_WORKSPACE_NAME_LENGTH = 100;

/** Validate a workspace name for the rename form. Returns an error message, or
 *  null when valid. */
export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Workspace name can't be empty.";
  if (trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    return `Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`;
  }
  return null;
}
