// Regression tests for PgPoolExecutor's libpq-correct TLS handling.
//
// The engine connects to the customer/sample Postgres with node-postgres, which
// upgrades sslmode=require to verify-full (it VERIFIES the server certificate).
// libpq's `require` means "encrypt, don't verify"; only verify-ca/verify-full
// verify. The hosted sample DB presents a self-signed cert, so before this fix
// every agent query against it failed with a bare "self signed certificate".
//
// libpqSslConfig() maps sslmode to an explicit pg `ssl` option AND strips
// sslmode from the DSN. The strip is mandatory, not cosmetic: pg lets the
// parsed connection string override an explicit `ssl` config, so `ssl` alone is
// silently discarded (the "defeats pg's override" block below pins that).

import { describe, expect, test } from "bun:test";
import pg from "pg";
import { libpqSslConfig } from "../../src/executor/pg-pool.ts";

const SAMPLE_DSN =
  "postgres://midplane_sample:pw@midplane-sample-db.internal:5432/sample?sslmode=require";

// The TLS setting pg actually resolves from a Client config, AFTER it merges
// the parsed connection string over the explicit config — i.e. the value that
// governs the real handshake, not just what we passed in.
function effectiveSsl(config: pg.ClientConfig): unknown {
  return (
    new pg.Client(config) as unknown as { connectionParameters: { ssl: unknown } }
  ).connectionParameters.ssl;
}

describe("libpqSslConfig — sslmode → pg ssl", () => {
  test("require encrypts but does NOT verify (the sample-DB self-signed fix)", () => {
    const { connectionString, ssl } = libpqSslConfig(SAMPLE_DSN);
    expect(ssl).toEqual({ rejectUnauthorized: false });
    expect(connectionString).not.toContain("sslmode");
    // Everything else about the DSN survives untouched.
    expect(connectionString).toBe(
      "postgres://midplane_sample:pw@midplane-sample-db.internal:5432/sample",
    );
  });

  test("prefer/allow/no-verify also encrypt without verifying", () => {
    for (const mode of ["prefer", "allow", "no-verify"]) {
      const { ssl } = libpqSslConfig(`postgres://u:p@h:5432/db?sslmode=${mode}`);
      expect(ssl).toEqual({ rejectUnauthorized: false });
    }
  });

  test("verify-ca/verify-full still verify the certificate", () => {
    for (const mode of ["verify-ca", "verify-full"]) {
      const { ssl } = libpqSslConfig(`postgres://u:p@h:5432/db?sslmode=${mode}`);
      expect(ssl).toEqual({ rejectUnauthorized: true });
    }
  });

  test("disable turns TLS off", () => {
    const { ssl } = libpqSslConfig("postgres://u:p@h:5432/db?sslmode=disable");
    expect(ssl).toBe(false);
  });

  test("other query params are preserved when sslmode is stripped", () => {
    const { connectionString, ssl } = libpqSslConfig(
      "postgres://u:p@h:5432/db?application_name=midplane&sslmode=require",
    );
    expect(ssl).toEqual({ rejectUnauthorized: false });
    expect(connectionString).toContain("application_name=midplane");
    expect(connectionString).not.toContain("sslmode");
  });

  test("a DSN with no sslmode is left untouched", () => {
    const dsn = "postgres://u:p@h:5432/db";
    const { connectionString, ssl } = libpqSslConfig(dsn);
    expect(ssl).toBeUndefined();
    expect(connectionString).toBe(dsn);
  });

  test("an unknown sslmode is passed through unchanged", () => {
    const dsn = "postgres://u:p@h:5432/db?sslmode=banana";
    const { connectionString, ssl } = libpqSslConfig(dsn);
    expect(ssl).toBeUndefined();
    expect(connectionString).toBe(dsn);
  });

  test("an unparseable DSN is passed through unchanged", () => {
    const kv = "host=h dbname=db sslmode=require";
    const { connectionString, ssl } = libpqSslConfig(kv);
    expect(ssl).toBeUndefined();
    expect(connectionString).toBe(kv);
  });
});

describe("libpqSslConfig defeats pg's connection-string override", () => {
  test("without stripping, an explicit ssl is overridden back to verify (the bug)", () => {
    // Passing ssl alongside sslmode=require: pg's parse() wins and forces `{}`
    // (verify), which is exactly what rejects the self-signed sample cert. This
    // documents WHY the helper strips sslmode — if anyone "simplifies" the fix
    // to ssl-only, this captures the regression.
    expect(
      effectiveSsl({ connectionString: SAMPLE_DSN, ssl: { rejectUnauthorized: false } }),
    ).toEqual({});
  });

  test("with the helper, the effective TLS is encrypt-without-verify", () => {
    expect(effectiveSsl(libpqSslConfig(SAMPLE_DSN))).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("with the helper, verify-full still resolves to a verifying connection", () => {
    expect(
      effectiveSsl(libpqSslConfig("postgres://u:p@h:5432/db?sslmode=verify-full")),
    ).toEqual({ rejectUnauthorized: true });
  });
});
