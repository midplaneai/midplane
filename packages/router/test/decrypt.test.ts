import { describe, expect, it, vi } from "vitest";

import type { ProjectDatabase } from "@midplane-cloud/db";
import type { KmsContext } from "@midplane-cloud/kms";

import { DecryptCache } from "../src/decrypt-cache.ts";
import { dsnRevision, DsnResolver } from "../src/decrypt.ts";
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
  guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
  approvals: {
    row_changes: false,
    whole_table_writes: false,
    schema_changes: false,
    expires_after_seconds: 1800,
    writes: false,
  },
  columnMasks: {},
  ignoredColumns: {},
  rotatedAt: null,
  lastKmsSuccessAt: null,
  createdAt: new Date(),
};
const region = "eu" as const;
const customerId = "cust-1";
const input = { projectDatabase: cdb, region, customerId };
const REV = dsnRevision(cdb.encryptedDsn);

const kms: KmsContext = { mode: "env", envKeys: { eu: "x".repeat(64) } };

describe("DsnResolver", () => {
  it("returns fresh from cache without calling KMS", async () => {
    const cache = new DecryptCache();
    cache.set("cdb-1", "eu", REV, "postgres://cached");
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
    expect(cache.get("cdb-1", "eu", REV).kind).toBe("fresh");
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

  // The KMS error used to be swallowed by a bare `catch {}`, so an outage that
  // stranded a whole region on a retired key logged the same opaque string as a
  // transient blip — and went unread for ten days. The cause must survive.
  it("carries the KMS failure reason out as `detail`", async () => {
    const cache = new DecryptCache();
    const decrypt = vi
      .fn()
      .mockRejectedValue(new Error("MIDPLANE_KMS_DEV_KEY_EU is not set"));
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("MIDPLANE_KMS_DEV_KEY_EU is not set");
  });

  it("stringifies a non-Error rejection into `detail`", async () => {
    const cache = new DecryptCache();
    const decrypt = vi.fn().mockRejectedValue("AccessDenied");
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("AccessDenied");
  });

  it("returns 'expired' as credential_unavailable", async () => {
    const start = 1_000_000;
    const clock = { t: start, now: () => start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", REV, "postgres://stale");
    clock.t += 71 * 60_000;
    const { db } = fakeDb();
    const decrypt = vi.fn();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(input);
    expect(r.ok).toBe(false);
    // Distinguishable from a KMS throw: the cache aged out without ever
    // reaching KMS, so `detail` must say so rather than echo a KMS message.
    if (!r.ok) expect(r.detail).toMatch(/cache expired/);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("on grace, returns cached plaintext immediately AND triggers async refresh", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", REV, "postgres://stale");
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
    cache.set("cdb-1", "eu", REV, "postgres://stale");
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
    cache.set("cdb-1", "eu", REV, "postgres://stale");
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

    expect(cache.get("cdb-1", "eu", REV).kind).toBe("miss");
  });

  it("(d) a warm cache on ANOTHER instance does not serve the pre-rotation password", async () => {
    // rotateProject fences and evicts the cache of the instance that ran it.
    // Every other web instance still holds the old plaintext, fresh for up to
    // 10 minutes; serving it would boot (or keep) an engine on the rotated-away
    // credential. The row this instance just read carries the new ciphertext,
    // so its revision no longer matches the cached one.
    const cache = new DecryptCache();
    cache.set("cdb-1", "eu", REV, "postgres://app:old-pass@db/app");
    const decrypt = vi.fn().mockResolvedValue("postgres://app:new-pass@db/app");
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const rotated = { ...cdb, encryptedDsn: Buffer.from("ciphertext-after-rotation") };
    const r = await resolver.resolve({ ...input, projectDatabase: rotated });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("miss");
      expect(r.plaintext).toBe("postgres://app:new-pass@db/app");
    }
    expect(decrypt).toHaveBeenCalledOnce();
    // The new password is cached under the new revision, and it is the only
    // entry: the old password is gone from memory, not just shadowed.
    const again = cache.get("cdb-1", "eu", dsnRevision(rotated.encryptedDsn));
    expect(again.kind).toBe("fresh");
    if (again.kind === "fresh") expect(again.plaintext).toBe("postgres://app:new-pass@db/app");
    expect(cache.size()).toBe(1);
  });

  it("a grace-window refresh stores the new plaintext under the revision it decrypted", async () => {
    // The refresh is keyed to the row the grace hit read. Stored under any
    // other revision, the next request on the same row would miss and pay
    // another KMS round-trip (or, on a KMS outage, fail) instead of hitting.
    const clock = { t: 1_000_000 };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", REV, "postgres://stale");
    clock.t += 11 * 60_000; // past TTL, inside grace

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt, now: () => clock.t });

    const first = await resolver.resolve(input);
    expect(first).toMatchObject({ ok: true, source: "grace" });
    resolveRefresh("postgres://refreshed");
    await new Promise((r) => setTimeout(r, 0));

    const second = await resolver.resolve(input);
    expect(second).toEqual({ ok: true, plaintext: "postgres://refreshed", source: "fresh" });
    expect(decrypt).toHaveBeenCalledOnce();
    // It decrypted the ciphertext the revision was taken from.
    expect(decrypt.mock.calls[0]).toContain(cdb.encryptedDsn);
  });

  it("a grace refresh still in flight when another instance rotates can't hand the old password to the new row", async () => {
    // No invalidate() ran on this instance, so the rotation fence doesn't
    // apply: the straggling refresh of the OLD ciphertext lands after the new
    // row was already decrypted and overwrites that entry. The revision check
    // is what keeps a caller holding the rotated row off the old password.
    const OLD = "postgres://app:old-pass@db/app";
    const NEW = "postgres://app:new-pass@db/app";
    const clock = { t: 1_000_000 };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", REV, OLD);
    clock.t += 11 * 60_000; // past TTL, inside grace

    const rotated = { ...cdb, encryptedDsn: Buffer.from("ciphertext-after-rotation") };
    let resolveOld!: (v: string) => void;
    const decrypt = vi.fn((_kms: KmsContext, ciphertext: Uint8Array) =>
      Buffer.from(ciphertext).equals(rotated.encryptedDsn)
        ? Promise.resolve(NEW)
        : new Promise<string>((res) => (resolveOld = res)),
    );
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt, now: () => clock.t });

    // 1. Old row in grace: served, and a refresh of the OLD ciphertext starts.
    await resolver.resolve(input);
    // 2. Another instance rotates; this request reads the new row.
    const afterRotation = { ...input, projectDatabase: rotated };
    expect(await resolver.resolve(afterRotation)).toMatchObject({ ok: true, plaintext: NEW });
    // 3. The straggling refresh lands with the old password.
    resolveOld(OLD);
    await new Promise((r) => setTimeout(r, 0));

    // 4. The rotated row still resolves to the new password.
    const r = await resolver.resolve(afterRotation);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plaintext).toBe(NEW);
  });

  it("dsnRevision changes with the ciphertext and nothing else", () => {
    expect(dsnRevision(Buffer.from("a"))).toBe(dsnRevision(Buffer.from("a")));
    expect(dsnRevision(Buffer.from("a"))).not.toBe(dsnRevision(Buffer.from("b")));
  });

  it("calls onRefreshError when grace refresh fails", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("cdb-1", "eu", REV, "postgres://stale");
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
