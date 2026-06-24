// Pseudonymization dictionaries (decision: realistic deterministic fakes).
//
// These are TS-LITERAL arrays, NOT files read at runtime. The shipped engine is
// a `bun build --compile` binary that does NOT embed assets loaded via
// readFileSync (see learning bun-compile-readfilesync-not-embedded) — a wordlist
// on disk would ENOENT. As module-level constants these compile straight into
// the binary, the same way schema.sql is embedded as a string literal.
//
// The lists are intentionally modest (curated, fictional). `pseudonymize{kind}`
// maps a value to a stable index into one of these via HMAC(salt, value), so the
// only requirement is that they're non-empty and stable across builds (the index
// is `digest mod len`, so reordering would change every pseudonym — treat the
// order as part of the data contract, append-only).

// Given names — gender-neutral mix, ASCII, no diacritics (kept simple so a fake
// email composed from these never needs escaping).
export const FIRST_NAMES = [
  "Avery", "Bailey", "Cameron", "Casey", "Charlie", "Dakota", "Drew", "Elliot",
  "Emerson", "Finley", "Frankie", "Harper", "Hayden", "Hollis", "Jamie", "Jordan",
  "Kai", "Kendall", "Lennon", "Logan", "Marley", "Micah", "Morgan", "Noel",
  "Oakley", "Parker", "Peyton", "Quinn", "Reese", "Riley", "Robin", "Rowan",
  "Sage", "Sawyer", "Shay", "Skyler", "Sloan", "Spencer", "Sutton", "Tatum",
  "Taylor", "Toby", "Tristan", "Wren", "Ari", "Blake", "Devon", "Ellis",
  "Gray", "Indigo", "June", "Lane", "Maxwell", "Nico", "Phoenix", "Remy",
  "Salem", "Teagan", "Vesper", "Wallis", "Wynn", "Yael", "Zephyr", "Zion",
] as const;

// Family names — common Anglophone surnames, ASCII.
export const LAST_NAMES = [
  "Adler", "Bishop", "Brooks", "Calloway", "Castellano", "Chambers", "Donovan",
  "Ellison", "Fairfax", "Fletcher", "Forsythe", "Gallagher", "Hawkins",
  "Hollingsworth", "Ingram", "Jennings", "Kingsley", "Lockhart", "Lowery",
  "Mercer", "Montgomery", "Nakamura", "Okafor", "Pemberton", "Quigley", "Ramsey",
  "Redding", "Sandoval", "Sinclair", "Stafford", "Sterling", "Thackeray",
  "Underhill", "Vance", "Wakefield", "Whitlock", "Winslow", "Yates", "Zimmerman",
  "Ashby", "Beckett", "Cromwell", "Delacroix", "Easton", "Fairbanks", "Granger",
  "Holloway", "Larsson", "Marchetti", "Nightingale", "Oswald", "Prescott",
  "Rosenthal", "Saunders", "Tennyson", "Vandenberg", "Westbrook", "Abernathy",
  "Blackwood", "Cortland", "Driscoll", "Everhart", "Fennimore", "Galloway",
] as const;

// Email domains — example/test domains reserved for documentation (RFC 2606 +
// common fictional hosts), so a generated address never collides with a real one.
export const EMAIL_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "mail.example.com",
  "inbox.example.org",
  "users.example.net",
  "test.example.com",
  "fake.example.org",
] as const;
