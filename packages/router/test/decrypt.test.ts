import { describe, expect, it, vi } from "vitest";

import type { ProjectDatabase } from "@midplane-cloud/db";
import type { KmsContext } from "@midplane-cloud/kms";

import { DecryptCache } from "../src/decrypt-cache.ts";
import { DsnResolver } from "../src/decrypt.ts";
import type { Db } from "../src/resolve.ts";

interface UpdateCapture {
  values: Record<string, unknown> | null;
}

function fakeDb(): { db: Db; capture: UpdateCapture } {
  const capture: UpdateCapture = { values: null };
  const chain = {
    set(values: Record<string, unknown>) {
      capture.values = values;
      return this;
    },
    where() {
      return Promise.resolve();
    },
  };
  const db = {
    update() {
      return chain;
    },
  } as unknown as Db;
  return { db, capture };
}

// Schema 0008 split: the resolver now keys on project_databases (per-
// credential), not on projects (parent). Region + customer_id are
// passed alongside since they live on the parent.
const cdb: ProjectDatabase = {
  id: "cdb-1",
  projectId: "conn-1",
  name: "main",
  encryptedDsn: Buffer.from("ciphertext"),
  kmsKeyId: "env:eu",
  tableAccess: { default: "deny", tables: {} },
  tenantScope: { column: null, overrides: {}, exempt: [] },
  guardrails: { block_unqualified_dml: true, block_ddl: true },
  columnMasks: {},
  ignoredColumns: {},
  rotatedAt: null,
  lastKmsSuccessAt: null,
  createdAt: new Date(),
};
const region = "eu" as const;
const customerId = "cust-1";
const input = { projectDatabase: cdb, region, customerId };

const kms: KmsContext = { mode: "env", envKeys: { eu: "x".repeat(64) } };

describe("DsnResolver", () => {
  it("returns fresh from cache without calling KMS", async () => {
    const cache = new DecryptCache();
    cache.set("cdb-1", "eu", "postgres://cached");
    const decrypt = vi.fn();
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("fresh");
      expect(r.plaintext).toBe("postgres://cached");
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("on miss, decrypts via KMS, caches, and persists last_kms_success_at", async () => {
    const cache = new DecryptCache();
    const decrypt = vi.fn().mockResolvedValue("postgres://decrypted");
    const { db, capture } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plaintext).toBe("postgres://decrypted");
    expect(decrypt).toHaveBeenCalledOnce();
    expect(capture.values).toMatchObject({
      lastKmsSuccessAt: expect.any(Date),
    });
    expect(cache.get("cdb-1", "eu").kind).toBe("fresh");
  });

  it("on miss, refuses with credential_unavailable when KMS throws", async () => {
    const cache = new DecryptCache();
    const decrypt = vi.fn().mockRejectedValue(new Error("kms down"));
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("credential_unavailable");
  });

  it("returns 'expired' as credential_unavailable", async () => {
    const start = 1_000_000;
    const clock = { t: start, now: () => start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", "postgres://stale");
    clock.t += 71 * 60_000;
    const { db } = fakeDb();
    const decrypt = vi.fn();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("on grace, returns cached plaintext immediately AND triggers async refresh", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", "postgres://stale");
    clock.t += 11 * 60_000; // past TTL, inside grace

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db, capture } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("grace");
      expect(r.plaintext).toBe("postgres://stale");
    }
    expect(decrypt).toHaveBeenCalledOnce();
    expect(capture.values).toBeNull(); // refresh hasn't completed yet

    resolveRefresh("postgres://refreshed");
    await new Promise((r) => setTimeout(r, 0));
    expect(capture.values).toMatchObject({
      lastKmsSuccessAt: expect.any(Date),
    });
  });

  it("dedupes concurrent grace-window refreshes — single KMS call", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", "postgres://stale");
    clock.t += 11 * 60_000;

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    await Promise.all([
      resolver.resolve(input),
      resolver.resolve(input),
      resolver.resolve(input),
    ]);
    expect(decrypt).toHaveBeenCalledOnce();
    resolveRefresh("postgres://x");
    await new Promise((r) => setTimeout(r, 0));
  });

  it("rotation race: an in-flight grace refresh that lands AFTER invalidate cannot repopulate the cache with old plaintext", async () => {
    // Reproduces the security-critical race the rotation flow guards against.
    // 1. cache is in grace; resolve() schedules a KMS refresh
    // 2. while KMS is in flight, rotation invalidates the cache
    // 3. KMS resolves with the OLD plaintext (its row snapshot was the
    //    pre-rotation row); without the fence, cache.set would happily
    //    accept the write and the next request would see "fresh" old plaintext.
    //
    // 0008: keying is per-credential (projectDatabaseId) so rotation
    // on one DB only invalidates its own cache slot — siblings unaffected.
    const clock = { t: 1_000_000 };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", "postgres://stale");
    clock.t += 11 * 60_000; // past TTL → grace

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db } = fakeDb();
    const resolver = new DsnResolver({
      db,
      cache,
      kms,
      decrypt,
      now: () => clock.t,
    });

    // Phase 1: grace path schedules the refresh; KMS is now in flight.
    await resolver.resolve(input);

    // Phase 2: rotation invalidates while KMS is still pending.
    clock.t += 10;
    cache.invalidate("cdb-1", "eu");

    // Phase 3: KMS finally resolves with the pre-rotation plaintext. The
    // refresh's cache.set must be dropped by the fence.
    clock.t += 10;
    resolveRefresh("postgres://stale");
    await new Promise((r) => setTimeout(r, 0));

    expect(cache.get("cdb-1", "eu").kind).toBe("miss");
  });

  it("calls onRefreshError when grace refresh fails", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", "postgres://stale");
    clock.t += 11 * 60_000;

    const decrypt = vi.fn().mockRejectedValue(new Error("kms still down"));
    const onRefreshError = vi.fn();
    const { db } = fakeDb();
    const resolver = new DsnResolver({
      db,
      cache,
      kms,
      decrypt,
      onRefreshError,
    });

    await resolver.resolve(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(onRefreshError).toHaveBeenCalledOnce();
  });
});
