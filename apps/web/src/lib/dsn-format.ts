// Shape checks for a pasted Postgres connection string, plus the human
// sentence the UI shows when one fails.
//
// Deliberately dependency-free and side-effect-free so the SAME function runs
// in three places:
//
//   browser  — blur-time format check in the paste forms, and a pre-flight
//              before the reachability probe (a typo shouldn't cost a round
//              trip or a slot in the ping rate-limit budget)
//   route    — /api/projects/test-dsn and siblings
//   action   — createProject / addDatabase / rotate server actions
//
// One implementation means a paste can't be waved through in the field and
// then rejected on submit (or vice versa). Client components may import this
// freely — unlike @/lib/projects it pulls in no `postgres` driver.
//
// Voice rules for the messages: name what's wrong in one sentence, then give
// the remedy in `hint`. Never echo the string back — it carries a password.
// The only thing quoted is a URL scheme.

/** The canonical shape shown in placeholders and hints. */
export const DSN_EXAMPLE =
  "postgres://user:password@host:5432/dbname?sslmode=require";

export type DsnProblem = {
  /** One sentence naming the problem. Safe to render verbatim. */
  message: string;
  /** Concrete next step, when there is one worth spelling out. */
  hint?: string;
};

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const POSTGRES_SCHEME_RE = /^postgres(ql)?:\/\//i;
// libpq's keyword/value form — what psql accepts and what cloud consoles
// sometimes show next to the URL ("host=… port=… dbname=…").
const LIBPQ_KEYWORD_RE = /(^|\s)(host|hostaddr|dbname|user|password|port)\s*=/i;
// An unreplaced doc placeholder: both brackets, no whitespace between.
const PLACEHOLDER_RE = /<[^\s>]*>/;

/** Whitespace and quotes are never meaningful around a DSN, and they ride
 *  along on copies out of a shell, a YAML file or a wrapped terminal. */
export function normalizeDsn(value: string): string {
  return value.trim();
}

/** Credentials with an EMPTY authority is a legal libpq shape when the host
 *  arrives as a query parameter (`postgresql://user:pass@/db?host=…`), and
 *  pg-connection-string parses it — but WHATWG `new URL` rejects it outright.
 *  Re-parse with the userinfo dropped so the rest of the string can still be
 *  read. Greedy up to the LAST `@` so an unencoded `@` in the password doesn't
 *  cut the match short. Returns null only when the string really is unparseable. */
function parseDsnUrl(dsn: string): URL | null {
  try {
    return new URL(dsn);
  } catch {
    // fall through to the empty-authority retry
  }
  const withoutUserinfo = /^([a-z][a-z0-9+.-]*:\/\/)(.*)@(\/.*)$/i.exec(dsn);
  if (!withoutUserinfo) return null;
  try {
    return new URL(`${withoutUserinfo[1]}${withoutUserinfo[3]}`);
  } catch {
    return null;
  }
}

/**
 * The first thing wrong with `value` as a Postgres connection string, or null
 * when its shape is usable. Shape only — whether the host answers is the ping
 * probe's question (see lib/ping-guard.ts).
 */
export function describeDsnProblem(value: unknown): DsnProblem | null {
  if (typeof value !== "string" || normalizeDsn(value).length === 0) {
    return {
      message: "Paste your database connection string.",
      hint: `It looks like ${DSN_EXAMPLE}`,
    };
  }
  const dsn = normalizeDsn(value);

  // A copied shell command: `psql "postgres://…"`.
  if (/^psql\b/i.test(dsn)) {
    return {
      message: "That's a psql command, not a connection string.",
      hint: "Paste just the postgres:// URL — without the psql prefix or the quotes.",
    };
  }
  // Quotes survive a copy out of a shell, an env file or YAML.
  if (/^["'`]/.test(dsn) || /["'`]$/.test(dsn)) {
    return {
      message: "The connection string is wrapped in quotes.",
      hint: "Paste it without the surrounding quotes.",
    };
  }
  if (/^jdbc:/i.test(dsn)) {
    return {
      message: "That's a JDBC URL.",
      hint: "Drop the jdbc: prefix — postgresql://… is the part we need.",
    };
  }
  const scheme = SCHEME_RE.exec(dsn)?.[1]?.toLowerCase() ?? null;
  if (!scheme) {
    // libpq keyword form is the common no-scheme paste, and it deserves its
    // own sentence — "add a scheme" is not the fix.
    if (LIBPQ_KEYWORD_RE.test(dsn)) {
      return {
        message: "That's the libpq keyword format (host=… dbname=…).",
        hint: `Midplane needs the URL form: ${DSN_EXAMPLE}`,
      };
    }
    return {
      message:
        "A connection string starts with postgres:// or postgresql://.",
      hint: `Full shape: ${DSN_EXAMPLE}`,
    };
  }
  if (!POSTGRES_SCHEME_RE.test(dsn)) {
    return {
      message: `Midplane connects to Postgres, and this is a ${scheme}:// URL.`,
      hint: "Paste a Postgres connection string — postgres:// or postgresql://.",
    };
  }
  // No legal URL has interior whitespace (a space inside a password has to be
  // percent-encoded), so this is a wrapped or truncated paste.
  if (/\s/.test(dsn)) {
    return {
      message: "The connection string has a space or line break inside it.",
      hint: "Paste it as a single line. A space in a password must be written as %20.",
    };
  }
  if (PLACEHOLDER_RE.test(dsn)) {
    return {
      message: "The connection string still has a <placeholder> in it.",
      hint: "Replace the bracketed parts with your own host, user and password.",
    };
  }
  const url = parseDsnUrl(dsn);
  if (!url) {
    return {
      message: "This isn't a connection string we can parse.",
      hint: "If the password contains @ : / ? # or %, percent-encode it — @ becomes %40.",
    };
  }
  // libpq (and node-postgres via pg-connection-string) also takes the host as a
  // query parameter — `postgresql:///dbname?host=db.example.com&port=5432`, and
  // the socket form `?host=/var/run/postgresql`. Those are legal connection
  // strings with an empty URL authority, so read the parameter before calling
  // it hostless: rejecting them here would block create/add/rotate on a DSN
  // the driver connects with fine. Whether the host ANSWERS is the probe's
  // question, not this checker's (same reason localhost passes).
  const host =
    url.hostname ||
    url.searchParams.get("host") ||
    url.searchParams.get("hostaddr") ||
    "";
  if (!host) {
    return {
      message: "The connection string has no host.",
      hint: `The host goes after the @: ${DSN_EXAMPLE}`,
    };
  }
  return null;
}

/** Type guard used by the routes and server actions. Equivalent to "no
 *  problem to report" — keep the two in one place so a message can never
 *  disagree with the gate that produced it. */
export function isValidDsn(value: unknown): value is string {
  return describeDsnProblem(value) === null;
}

/** `message` and `hint` as one string, for the surfaces that can only carry a
 *  single line (a thrown server-action Error, a REST `error` field). */
export function dsnProblemText(problem: DsnProblem): string {
  return problem.hint ? `${problem.message} ${problem.hint}` : problem.message;
}
