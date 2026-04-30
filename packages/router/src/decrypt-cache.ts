// Bounded TTL cache for decrypted DSNs.
//
// Trust posture: decrypted plaintext lives in process memory only. On KMS
// unavailability we serve cached entries during a 60-minute grace window,
// then refuse new sessions for that credential (per design doc "KMS
// degradation"). Plaintext is zeroed on eviction.
//
// Bounded size: simple LRU cap. Capacity sized so a single tenant pinning
// one entry can't push out other tenants' working sets in steady state.

import type { Region } from "@midplane-cloud/kms";

export interface CacheEntry {
  plaintext: string;
  /** Unix ms when the cached plaintext expires (10 min after KMS success). */
  expiresAt: number;
  /** Unix ms of last successful KMS decrypt for this credential. */
  lastKmsSuccessAt: number;
}

export interface DecryptCacheOptions {
  /** Default 10 minutes. */
  ttlMs?: number;
  /** Default 60 minutes past TTL during which stale entries still serve. */
  graceMs?: number;
  /** Default 256. */
  capacity?: number;
  /** Injected for tests. */
  now?: () => number;
}

export type DecryptResult =
  | { kind: "fresh"; plaintext: string }
  | { kind: "grace"; plaintext: string; ageMs: number }
  | { kind: "expired" }
  | { kind: "miss" };

export class DecryptCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(opts: DecryptCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.graceMs = opts.graceMs ?? 60 * 60_000;
    this.capacity = opts.capacity ?? 256;
    this.now = opts.now ?? Date.now;
  }

  set(connectionId: string, region: Region, plaintext: string): void {
    const now = this.now();
    const key = `${region}:${connectionId}`;
    // Move-to-front via delete + set; Map iteration is insertion order.
    this.map.delete(key);
    this.map.set(key, {
      plaintext,
      expiresAt: now + this.ttlMs,
      lastKmsSuccessAt: now,
    });
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (!oldestKey) break;
      this.evict(oldestKey);
    }
  }

  /**
   * Look up cached plaintext.
   *  - "fresh" : within TTL.
   *  - "grace" : past TTL but inside (TTL + grace) — serve, but caller
   *              should attempt KMS refresh out-of-band.
   *  - "expired": past TTL + grace — must refuse new sessions.
   *  - "miss"  : never cached.
   */
  get(connectionId: string, region: Region): DecryptResult {
    const key = `${region}:${connectionId}`;
    const entry = this.map.get(key);
    if (!entry) return { kind: "miss" };
    const now = this.now();
    if (now <= entry.expiresAt) {
      // Refresh LRU position.
      this.map.delete(key);
      this.map.set(key, entry);
      return { kind: "fresh", plaintext: entry.plaintext };
    }
    const ageMs = now - entry.lastKmsSuccessAt;
    if (ageMs <= this.ttlMs + this.graceMs) {
      return { kind: "grace", plaintext: entry.plaintext, ageMs };
    }
    this.evict(key);
    return { kind: "expired" };
  }

  invalidate(connectionId: string, region: Region): void {
    this.evict(`${region}:${connectionId}`);
  }

  size(): number {
    return this.map.size;
  }

  private evict(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    // Best-effort plaintext zeroing. JS strings are immutable, so this is
    // mainly to drop the reference; the GC reclaims the bytes.
    (e as { plaintext: string }).plaintext = "";
    this.map.delete(key);
  }
}
