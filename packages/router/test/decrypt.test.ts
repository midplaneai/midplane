import { describe, expect, it, vi } from "vitest";

import type { Connection } from "@midplane-cloud/db";
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

const conn: Connection = {
  id: "conn-1",
  customerId: "cust-1",
  region: "fra",
  encryptedDsn: Buffer.from("ciphertext"),
  kmsKeyId: "env:fra",
  mcpToken: "tok",
  createdAt: new Date(),
  rotatedAt: null,
  lastKmsSuccessAt: null,
};

const kms: KmsContext = { mode: "env", envKeys: { fra: "x".repeat(64) } };

describe("DsnResolver", () => {
  it("returns fresh from cache without calling KMS", async () => {
    const cache = new DecryptCache();
    cache.set("conn-1", "fra", "postgres://cached");
    const decrypt = vi.fn();
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(conn);
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

    const r = await resolver.resolve(conn);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plaintext).toBe("postgres://decrypted");
    expect(decrypt).toHaveBeenCalledOnce();
    expect(capture.values).toMatchObject({
      lastKmsSuccessAt: expect.any(Date),
    });
    expect(cache.get("conn-1", "fra").kind).toBe("fresh");
  });

  it("on miss, refuses with credential_unavailable when KMS throws", async () => {
    const cache = new DecryptCache();
    const decrypt = vi.fn().mockRejectedValue(new Error("kms down"));
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(conn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("credential_unavailable");
  });

  it("returns 'expired' as credential_unavailable", async () => {
    const start = 1_000_000;
    const clock = { t: start, now: () => start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("conn-1", "fra", "postgres://stale");
    clock.t += 71 * 60_000;
    const { db } = fakeDb();
    const decrypt = vi.fn();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(conn);
    expect(r.ok).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("on grace, returns cached plaintext immediately AND triggers async refresh", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("conn-1", "fra", "postgres://stale");
    clock.t += 11 * 60_000; // past TTL, inside grace

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db, capture } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    const r = await resolver.resolve(conn);
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
    cache.set("conn-1", "fra", "postgres://stale");
    clock.t += 11 * 60_000;

    let resolveRefresh!: (v: string) => void;
    const decrypt = vi.fn(
      () => new Promise<string>((res) => (resolveRefresh = res)),
    );
    const { db } = fakeDb();
    const resolver = new DsnResolver({ db, cache, kms, decrypt });

    await Promise.all([
      resolver.resolve(conn),
      resolver.resolve(conn),
      resolver.resolve(conn),
    ]);
    expect(decrypt).toHaveBeenCalledOnce();
    resolveRefresh("postgres://x");
    await new Promise((r) => setTimeout(r, 0));
  });

  it("calls onRefreshError when grace refresh fails", async () => {
    const start = 1_000_000;
    const clock = { t: start };
    const cache = new DecryptCache({ now: () => clock.t });
    cache.set("conn-1", "fra", "postgres://stale");
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

    await resolver.resolve(conn);
    await new Promise((r) => setTimeout(r, 0));
    expect(onRefreshError).toHaveBeenCalledOnce();
  });
});
