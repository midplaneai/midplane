// The pasted-DSN checker. It runs in three places (field blur, probe
// pre-flight, route/action gate), so these cases pin two things at once: the
// verdict (is this string usable) and the sentence the user reads.
//
// The bad-paste table is drawn from what actually lands in the box —
// `psql "…"` copied out of a terminal, a quoted env-file line, the libpq
// keyword form a cloud console shows next to the URL, a wrapped multi-line
// paste, an unencoded `@` in the password. Every one of those used to surface
// as "invalid body".

import { describe, expect, it } from "vitest";

import {
  describeDsnProblem,
  dsnProblemText,
  isValidDsn,
  normalizeDsn,
} from "../src/lib/dsn-format.ts";

describe("describeDsnProblem — accepts", () => {
  const good = [
    "postgres://u:p@db.example.com:5432/app",
    "postgresql://u:p@db.example.com:5432/app?sslmode=require",
    "POSTGRES://u:p@db.example.com/app",
    // Password with an unencoded @ — WHATWG URL takes the last @ as the
    // delimiter, so this parses and the driver gets a host. Not our business
    // to second-guess.
    "postgres://user:p@ss@host/db",
    // No database segment: libpq defaults dbname to the user.
    "postgres://u:p@host:5432",
    // IPv6 literal host.
    "postgres://u:p@[2001:db8::1]:5432/app",
    // libpq puts the host in a query parameter when the authority is empty —
    // pg-connection-string reads it, so the driver connects fine and the gate
    // must not block create/add/rotate on it.
    "postgresql:///dbname?host=db.example.com&port=5432",
    "postgresql://u:p@/dbname?host=db.example.com",
    // Socket form. Unreachable from the cloud, but that's the probe's verdict
    // to deliver, not a format error.
    "postgresql:///dbname?host=/var/run/postgresql",
    "postgresql:///dbname?hostaddr=203.0.113.10",
    // Whitespace around the paste is normalized, not rejected.
    "  postgres://u:p@db.example.com/app\n",
  ];
  for (const dsn of good) {
    it(`no problem: ${dsn.trim().slice(0, 44)}`, () => {
      expect(describeDsnProblem(dsn)).toBeNull();
      expect(isValidDsn(dsn)).toBe(true);
    });
  }
});

describe("describeDsnProblem — names what's wrong", () => {
  const cases: Array<{ label: string; input: unknown; expect: RegExp }> = [
    { label: "empty", input: "", expect: /paste your database connection/i },
    { label: "whitespace only", input: "   ", expect: /paste your database/i },
    { label: "not a string", input: null, expect: /paste your database/i },
    {
      label: "a copied psql command",
      input: 'psql "postgres://u:p@host/db"',
      expect: /psql command/i,
    },
    {
      label: "quoted paste",
      input: '"postgres://u:p@host/db"',
      expect: /wrapped in quotes/i,
    },
    {
      label: "single-quoted paste",
      input: "'postgres://u:p@host/db'",
      expect: /wrapped in quotes/i,
    },
    {
      label: "jdbc url",
      input: "jdbc:postgresql://host:5432/db",
      expect: /jdbc/i,
    },
    {
      label: "libpq keyword form",
      input: "host=db.example.com port=5432 dbname=app user=u",
      expect: /libpq keyword format/i,
    },
    {
      label: "no scheme",
      input: "u:p@db.example.com:5432/app",
      expect: /starts with postgres:\/\//i,
    },
    {
      label: "another database's scheme",
      input: "mysql://u:p@host/db",
      expect: /this is a mysql:\/\/ url/i,
    },
    {
      label: "an http url",
      input: "https://db.example.com",
      expect: /this is a https:\/\/ url/i,
    },
    {
      label: "wrapped across lines",
      input: "postgres://u:p@db.example.com:5432/app\n?sslmode=require",
      expect: /space or line break/i,
    },
    {
      label: "unreplaced placeholder",
      input: "postgres://u:<password>@host:5432/db",
      expect: /<placeholder>/i,
    },
    {
      label: "unparseable",
      input: "postgres://u:p@host:notaport/db",
      expect: /can't parse|isn't a connection string we can parse/i,
    },
    {
      label: "no host in the authority or the query",
      input: "postgres:///app",
      expect: /no host/i,
    },
    {
      label: "empty host query parameter",
      input: "postgres:///app?host=",
      expect: /no host/i,
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const problem = describeDsnProblem(c.input);
      expect(problem, `expected a problem for ${c.label}`).not.toBeNull();
      expect(problem!.message).toMatch(c.expect);
      expect(isValidDsn(c.input)).toBe(false);
    });
  }

  it("never echoes the connection string back (it carries a password)", () => {
    const secret = "hunter2-do-not-leak";
    const problem = describeDsnProblem(`mysql://u:${secret}@host/db`);
    expect(dsnProblemText(problem!)).not.toContain(secret);
  });

  it("offers a remedy alongside the diagnosis", () => {
    const problem = describeDsnProblem("host=db.example.com dbname=app")!;
    expect(problem.hint).toMatch(/postgres:\/\//);
    expect(dsnProblemText(problem)).toBe(
      `${problem.message} ${problem.hint}`,
    );
  });
});

describe("normalizeDsn", () => {
  it("strips the whitespace a shell or env-file copy drags along", () => {
    expect(normalizeDsn("  postgres://u:p@host/db\n")).toBe(
      "postgres://u:p@host/db",
    );
  });
});
