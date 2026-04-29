// CredentialStore interface.
//
// Yields a Postgres connection string (or DSN) for a given tenant. The
// engine builds an executor (pg.Pool) keyed by tenant from this string.
// Two implementations ship by default; embedders can supply their own.
//
//   EnvCredentialStore   — single connection string from an env var.
//                          Production-suitable for single-tenant deploys.
//   <KMS adapter>        — KMS-backed implementations (e.g. AWS KMS) cache
//                          the decrypted DSN in process memory with a
//                          bounded TTL + grace window. Not shipped here;
//                          provide your own that satisfies the interface.

export interface CredentialStore {
  resolve(tenant_id: string): Promise<string>;
}

// Reads the DSN from an env var (default `DATABASE_URL`). Single-tenant —
// the same connection string is returned for every tenant_id.
export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly envVar: string = "DATABASE_URL") {}

  async resolve(_tenant_id: string): Promise<string> {
    const url = process.env[this.envVar];
    if (!url) {
      throw new Error(
        `EnvCredentialStore: env var ${this.envVar} is not set`,
      );
    }
    return url;
  }
}
