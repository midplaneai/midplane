// Decrypt state machine — composes DecryptCache + KMS + lastKmsSuccessAt
// persistence into the credential lifecycle the design doc specifies:
//
//   fresh   (<= 10min since KMS success)         → serve cached, no IO
//   grace   (10–70min since KMS success, KMS bad) → serve cached + async refresh
//   miss    (no cache entry)                      → call KMS, persist, serve
//   expired (> 70min, KMS still bad)              → refuse, credential_unavailable
//
// Async grace-refresh is deduplicated per connection: a burst of requests
// in the grace window triggers exactly one KMS call regardless of arrival
// count. The dedupe Map drops the entry once the refresh resolves so the
// next grace window starts fresh.
//
// Persistence: every successful KMS decrypt updates connections.last_kms_success_at
// in Postgres. The cache and the row stay in sync; the row is the durable
// witness across process restarts.

import { eq } from "drizzle-orm";

import { connections, type Connection } from "@midplane-cloud/db";
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
  onRefreshError?: (err: unknown, conn: Connection) => void;
}

interface ResolverState {
  inflight: Map<string, Promise<void>>;
}

export class DsnResolver {
  private readonly state: ResolverState = { inflight: new Map() };

  constructor(private readonly deps: ResolveDsnDeps) {}

  async resolve(conn: Connection): Promise<ResolveDsnResult> {
    const cache = this.deps.cache;
    const region = conn.region as Region;
    const cached = cache.get(conn.id, region);

    if (cached.kind === "fresh") {
      return { ok: true, plaintext: cached.plaintext, source: "fresh" };
    }

    if (cached.kind === "grace") {
      this.scheduleRefresh(conn);
      return { ok: true, plaintext: cached.plaintext, source: "grace" };
    }

    if (cached.kind === "expired") {
      return { ok: false, reason: "credential_unavailable" };
    }

    // miss → must hit KMS now. If KMS fails and the row says we're past the
    // 70-minute window, refuse. If we have no row history at all, refuse —
    // a freshly-rotated row with no prior success counts as expired here.
    try {
      const plaintext = await this.callKms(conn);
      cache.set(conn.id, region, plaintext);
      await this.persistSuccess(conn);
      return { ok: true, plaintext, source: "miss" };
    } catch {
      return { ok: false, reason: "credential_unavailable" };
    }
  }

  private scheduleRefresh(conn: Connection): void {
    if (this.state.inflight.has(conn.id)) return;
    const promise = (async () => {
      try {
        const plaintext = await this.callKms(conn);
        this.deps.cache.set(conn.id, conn.region as Region, plaintext);
        await this.persistSuccess(conn);
      } catch (err) {
        this.deps.onRefreshError?.(err, conn);
      } finally {
        this.state.inflight.delete(conn.id);
      }
    })();
    this.state.inflight.set(conn.id, promise);
  }

  private async callKms(conn: Connection): Promise<string> {
    const decrypt = this.deps.decrypt ?? decryptDsn;
    return decrypt(
      this.deps.kms,
      conn.encryptedDsn,
      conn.customerId,
      conn.region as Region,
      conn.kmsKeyId,
    );
  }

  private async persistSuccess(conn: Connection): Promise<void> {
    const now = new Date(this.deps.now ? this.deps.now() : Date.now());
    await this.deps.db
      .update(connections)
      .set({ lastKmsSuccessAt: now })
      .where(eq(connections.id, conn.id));
  }
}
