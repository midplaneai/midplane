// Regression tests for PgPoolExecutor's libpq-correct TLS handling.
//
// The engine connects to the customer/sample Postgres with node-postgres, which
// upgrades sslmode=require to verify-full (it VERIFIES the server certificate).
// libpq's `require` means "encrypt, don't verify" — unless a root CA is given,
// in which case it verifies against that CA (like verify-ca). The hosted sample
// DB presents a self-signed cert, so before this fix every agent query against
// it failed with a bare "self signed certificate".
//
// libpqCompatDsn() injects `uselibpqcompat=true` so pg-connection-string applies
// the correct libpq semantics — including for sslrootcert/sslcert/sslkey DSNs,
// which a hand-rolled `ssl` object can't handle (pg rebuilds ssl from the cert
// params and overrides an explicit ssl). The `effectiveSsl` assertions read the
// TLS config pg actually resolves, so they'd catch a silent regression if the
// driver ever stopped honoring the flag.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { libpqCompatDsn } from "../../src/executor/pg-pool.ts";

const SAMPLE_DSN =
  "postgres://midplane_sample:pw@midplane-sample-db.internal:5432/sample?sslmode=require";

// The TLS setting pg actually resolves from a Client config, AFTER it parses the
// connection string — i.e. the value that governs the real handshake, not just
// what the DSN literally said.
function effectiveSsl(config: pg.ClientConfig): Record<string, unknown> | boolean | undefined {
  return (
    new pg.Client(config) as unknown as {
      connectionParameters: { ssl: Record<string, unknown> | boolean | undefined };
    }
  ).connectionParameters.ssl;
}

describe("libpqCompatDsn — DSN rewriting", () => {
  test("adds uselibpqcompat=true while keeping the sslmode and the rest of the DSN", () => {
    const out = libpqCompatDsn(SAMPLE_DSN);
    expect(out).toContain("uselibpqcompat=true");
    expect(out).toContain("sslmode=require");
    expect(out).toContain("midplane_sample:pw@midplane-sample-db.internal:5432/sample");
  });

  test("preserves unrelated query params", () => {
    const out = libpqCompatDsn(
      "postgres://u:p@h:5432/db?application_name=midplane&sslmode=verify-full",
    );
    expect(out).toContain("application_name=midplane");
    expect(out).toContain("sslmode=verify-full");
    expect(out).toContain("uselibpqcompat=true");
  });

  test("leaves sslmode=no-verify untouched (the default path already maps it right)", () => {
    const dsn = "postgres://u:p@h:5432/db?sslmode=no-verify";
    expect(libpqCompatDsn(dsn)).toBe(dsn);
  });

  test("leaves a DSN with no sslmode untouched", () => {
    const dsn = "postgres://u:p@h:5432/db";
    expect(libpqCompatDsn(dsn)).toBe(dsn);
  });

  test("passes an unparseable DSN through unchanged", () => {
    const kv = "host=h dbname=db sslmode=require";
    expect(libpqCompatDsn(kv)).toBe(kv);
  });
});

describe("libpqCompatDsn — effective TLS pg resolves", () => {
  test("require without a root CA encrypts but does NOT verify (the sample-DB fix)", () => {
    expect(effectiveSsl({ connectionString: libpqCompatDsn(SAMPLE_DSN) })).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("without the flag, require resolves to verify (the original bug)", () => {
    // Raw sslmode=require -> pg forces ssl={} (rejectUnauthorized defaults true
    // = verify), which is exactly what rejects the self-signed sample cert.
    expect(effectiveSsl({ connectionString: SAMPLE_DSN })).toEqual({});
  });

  test("verify-full still verifies the certificate", () => {
    // {} means verify (rejectUnauthorized defaults to true); the key point is it
    // is NOT weakened to rejectUnauthorized:false.
    const ssl = effectiveSsl({
      connectionString: libpqCompatDsn("postgres://u:p@h:5432/db?sslmode=verify-full"),
    }) as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).not.toBe(false);
  });

  test("disable turns TLS off", () => {
    expect(
      effectiveSsl({ connectionString: libpqCompatDsn("postgres://u:p@h:5432/db?sslmode=disable") }),
    ).toBe(false);
  });
});

// The reviewer's case: sslmode=require WITH a root CA must NOT collapse to naive
// no-verify. libpq treats require+rootcert like verify-ca — verify the chain
// against the given CA (hostname check skipped). A hand-rolled ssl object was
// silently overridden by pg here; uselibpqcompat gets it right.
describe("libpqCompatDsn — require + sslrootcert verifies against the CA", () => {
  let tmp: string;
  let caPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "midplane-ssl-"));
    caPath = join(tmp, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n");
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("keeps CA verification (not bypassed to rejectUnauthorized:false)", () => {
    const dsn = `postgres://u:p@h:5432/db?sslmode=require&sslrootcert=${caPath}`;
    const ssl = effectiveSsl({ connectionString: libpqCompatDsn(dsn) }) as Record<string, unknown>;
    expect(String(ssl.ca)).toContain("BEGIN CERTIFICATE");
    // verify-ca semantics: verify the chain (rejectUnauthorized left at its
    // default of true), skip the hostname check.
    expect(ssl.rejectUnauthorized).not.toBe(false);
    expect(typeof ssl.checkServerIdentity).toBe("function");
  });
});
