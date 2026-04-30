// Bounded TTL cache for decrypted DSNs.
//
// Trust posture: decrypted plaintext lives in process memory only. On KMS
// unavailability we serve cached entries during a 60-minute grace window,
// then refuse new sessions for that credential (per design doc "KMS
// degradation"). Plaintext is zeroed on eviction.
//
// Bounded size: simple LRU cap. Capacity sized so a single tenant pinning
// one entry can't push out other tenants' working sets in steady state.
//
// Rotation fence: invalidate() records the timestamp it fired at. set()
// takes an optional `decryptStartedAt` — the time the caller began the
// KMS round-trip whose plaintext is now arriving. If the call started
// before the most recent invalidate, the write is dropped. Without this
// the in-flight grace refresh + miss-path KMS calls that are already
// outstanding when a customer rotates would land OLD plaintext into the
// cache after rotation evicted it, and the cache would serve the leaked
// credential for up to TTL minutes (the security incident the rotation
// path is meant to prevent).

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
  // Per-key high-water mark of the most recent invalidate(). set() rejects
  // writes whose decryption started before this. Survives the entry being
  // evicted because the fence isn't tied to entry presence — a caller mid
  // round-trip during invalidate must still be denied even when the entry
  // map is empty.
  private readonly invalidatedAt = new Map<string, number>();
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

  /**
   * Cache a freshly-decrypted plaintext.
   *
   * `decryptStartedAt` is the time the caller began the KMS round-trip
   * that produced this plaintext. If a rotation invalidated the entry
   * after that point, the write is dropped (returns false) and the cache
   * is left empty so the next request re-decrypts the new ciphertext.
   * Callers without rotation concerns may omit it; the implicit value is
   * `now()`, which never trips the fence.
   */
  set(
    connectionId: string,
    region: Region,
    plaintext: string,
    decryptStartedAt?: number,
  ): boolean {
    const now = this.now();
    const key = `${region}:${connectionId}`;
    const fenceAt = this.invalidatedAt.get(key);
    if (fenceAt !== undefined && decryptStartedAt !== undefined && decryptStartedAt < fenceAt) {
      // The decryption began before the most recent invalidate; this
      // plaintext is from the pre-rotation ciphertext and would resurrect
      // the leaked credential if cached.
      return false;
    }
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
    return true;
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
    const key = `${region}:${connectionId}`;
    this.invalidatedAt.set(key, this.now());
    this.evict(key);
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
