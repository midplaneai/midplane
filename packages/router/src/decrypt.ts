// Decrypt state machine — composes DecryptCache + KMS + lastKmsSuccessAt
// persistence into the credential lifecycle the design doc specifies:
//
//   fresh   (<= 10min since KMS success)         → serve cached, no IO
//   grace   (10–70min since KMS success, KMS bad) → serve cached + async refresh
//   miss    (no cache entry)                      → call KMS, persist, serve
//   expired (> 70min, KMS still bad)              → refuse, credential_unavailable
//
// Async grace-refresh is deduplicated per credential: a burst of requests
// in the grace window triggers exactly one KMS call regardless of arrival
// count. The dedupe Map drops the entry once the refresh resolves so the
// next grace window starts fresh.
//
// Persistence: every successful KMS decrypt updates
// connection_databases.last_kms_success_at in Postgres. The cache and the
// row stay in sync; the row is the durable witness across process restarts.
//
// 0008 schema split: this resolver now operates on connection_databases
// rows (per-credential) rather than connections (parent). Region is held
// on the parent row but threaded through here so the cache fence and KMS
// region routing match the OSS-side per-region key.

import { eq } from "drizzle-orm";

import {
  connectionDatabases,
  type ConnectionDatabase,
} from "@midplane-cloud/db";
import {
  decryptDsn,
  type KmsContext,
  type Region,
} from "@midplane-cloud/kms";

import { DecryptCache } from "./decrypt-cache.ts";
import type { Db } from "./resolve.ts";

export type ResolveDsnResult =
  | { ok: true; plaintext: string; source: "fresh" | "grace" | "miss" }
  | { ok: false; reason: "credential_unavailable" };

export interface ResolveDsnDeps {
  db: Db;
  cache: DecryptCache;
  kms: KmsContext;
  /** Injected so tests can simulate KMS failure. */
  decrypt?: typeof decryptDsn;
  now?: () => number;
  /** Optional logger; defaults to no-op so library stays quiet. */
  onRefreshError?: (
    err: unknown,
    ctx: { connectionDatabaseId: string; region: Region; customerId: string },
  ) => void;
}

interface ResolverState {
  inflight: Map<string, Promise<void>>;
}

export interface ResolveInput {
  connectionDatabase: ConnectionDatabase;
  /** Region of the parent connection — KMS keys are per-region, so the
   *  resolver needs it explicitly. */
  region: Region;
  /** Customer who owns the parent connection — used as KMS context. */
  customerId: string;
}

export class DsnResolver {
  private readonly state: ResolverState = { inflight: new Map() };

  constructor(private readonly deps: ResolveDsnDeps) {}

  async resolve(input: ResolveInput): Promise<ResolveDsnResult> {
    const cache = this.deps.cache;
    const { connectionDatabase: cdb, region, customerId } = input;
    const cached = cache.get(cdb.id, region);

    if (cached.kind === "fresh") {
      return { ok: true, plaintext: cached.plaintext, source: "fresh" };
    }

    if (cached.kind === "grace") {
      this.scheduleRefresh(input);
      return { ok: true, plaintext: cached.plaintext, source: "grace" };
    }

    if (cached.kind === "expired") {
      return { ok: false, reason: "credential_unavailable" };
    }

    // miss → must hit KMS now. If KMS fails we refuse — even if a row
    // historically had a successful decrypt, the cache is what gates
    // freshness; without an entry the credential is treated as expired.
    //
    // decryptStartedAt is captured BEFORE the KMS round-trip so the cache
    // can fence-out a write that races a concurrent rotation: if the row
    // is rotated and cache.invalidate fires while we're awaiting KMS, our
    // cache.set lands AFTER the invalidate but encodes the OLD plaintext;
    // the cache compares decryptStartedAt to its invalidatedAt watermark
    // and drops the stale write.
    const decryptStartedAt = this.deps.now ? this.deps.now() : Date.now();
    try {
      const plaintext = await this.callKms(cdb, region, customerId);
      cache.set(cdb.id, region, plaintext, decryptStartedAt);
      await this.persistSuccess(cdb.id);
      return { ok: true, plaintext, source: "miss" };
    } catch {
      return { ok: false, reason: "credential_unavailable" };
    }
  }

  private scheduleRefresh(input: ResolveInput): void {
    const { connectionDatabase: cdb, region, customerId } = input;
    if (this.state.inflight.has(cdb.id)) return;
    const decryptStartedAt = this.deps.now ? this.deps.now() : Date.now();
    const promise = (async () => {
      try {
        const plaintext = await this.callKms(cdb, region, customerId);
        this.deps.cache.set(cdb.id, region, plaintext, decryptStartedAt);
        await this.persistSuccess(cdb.id);
      } catch (err) {
        this.deps.onRefreshError?.(err, {
          connectionDatabaseId: cdb.id,
          region,
          customerId,
        });
      } finally {
        this.state.inflight.delete(cdb.id);
      }
    })();
    this.state.inflight.set(cdb.id, promise);
  }

  private async callKms(
    cdb: ConnectionDatabase,
    region: Region,
    customerId: string,
  ): Promise<string> {
    const decrypt = this.deps.decrypt ?? decryptDsn;
    return decrypt(
      this.deps.kms,
      cdb.encryptedDsn,
      customerId,
      region,
      cdb.kmsKeyId,
    );
  }

  private async persistSuccess(connectionDatabaseId: string): Promise<void> {
    const now = new Date(this.deps.now ? this.deps.now() : Date.now());
    await this.deps.db
      .update(connectionDatabases)
      .set({ lastKmsSuccessAt: now })
      .where(eq(connectionDatabases.id, connectionDatabaseId));
  }
}
