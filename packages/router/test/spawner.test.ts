import { describe, expect, it, vi } from "vitest";

import type { ColumnMasksConfig } from "@midplane-cloud/db";

import {
  bootFingerprint,
  ContainerRegistry,
  toDatabaseEntry,
  type SpawnDatabase,
  type SpawnedContainer,
  type Spawner,
  type SpawnOptions,
} from "../src/spawner.ts";

describe("toDatabaseEntry (ISSUE-007 launch: source-rewrite on)", () => {
  const base: SpawnDatabase = {
    name: "main",
    projectDatabaseId: "01HXYZ",
    dsn: "postgres://x",
    tableAccess: { default: "read", tables: {} },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
  };

  it("turns source-rewrite ON (maskSourceRewrite: true) and carries every field through", () => {
    const e = toDatabaseEntry({ ...base, columnMasks: { "public.users": { email: "full-redact" } } });
    expect(e).toEqual({
      name: "main",
      projectDatabaseId: "01HXYZ",
      tableAccess: base.tableAccess,
      tenantScope: base.tenantScope,
      guardrails: base.guardrails,
      columnMasks: { "public.users": { email: "full-redact" } },
      maskSourceRewrite: true,
    });
    // dsn is NOT part of the policy entry (it's injected as an env var, never YAML).
    expect("dsn" in e).toBe(false);
  });

  it("is inert on an unmasked DB — the serializer emits no flag/token without masks", () => {
    // maskSourceRewrite: true is still set, but serializeMultiDbPolicyToYaml only emits
    // the flag+token alongside a non-empty column_masks block (covered in db tests).
    const e = toDatabaseEntry(base);
    expect(e.columnMasks).toBeUndefined();
    expect(e.maskSourceRewrite).toBe(true);
  });
});

class StubSpawner implements Spawner {
  calls = 0;
  delayMs = 0;
  failNext = false;

  async spawn(_opts: SpawnOptions): Promise<SpawnedContainer> {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("spawn failed");
    }
    return {
      host: "127.0.0.1",
      port: 30000 + this.calls,
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }
}

const opts = (
  projectId = "01HXYZCONN000000000000000A",
  mask?: { columnMasks?: ColumnMasksConfig; maskSalt?: string },
): SpawnOptions => ({
  projectId,
  region: "eu",
  databases: [
    {
      name: "main",
      projectDatabaseId: "01HXYZMAIN0000000000000000",
      dsn: "postgres://x",
      tableAccess: { default: "deny", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
      guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
      ...(mask?.columnMasks ? { columnMasks: mask.columnMasks } : {}),
    },
  ],
  ...(mask?.maskSalt ? { maskSalt: mask.maskSalt } : {}),
});

describe("ContainerRegistry", () => {
  it("spawns once per project, reuses on second acquire", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const a = await reg.acquire(opts());
    const b = await reg.acquire(opts());
    expect(stub.calls).toBe(1);
    expect(b.port).toBe(a.port);
  });

  it("reuses the warm container when masks + salt are unchanged", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const masked = {
      columnMasks: { "public.users": { email: "full-redact" } } as ColumnMasksConfig,
      maskSalt: "salt-1",
    };
    const a = await reg.acquire(opts("01HXYZCONN000000000000000A", masked));
    const b = await reg.acquire(opts("01HXYZCONN000000000000000A", masked));
    expect(stub.calls).toBe(1);
    expect(b.port).toBe(a.port);
  });

  it("does NOT reuse a mask-less warm container for a masked request — respawns (bypass guard)", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    // A mask-less container boots first (e.g. a dry-run before masks were
    // carried). A later masked request must NOT be served by it.
    const cold = await reg.acquire(opts("01HXYZCONN000000000000000A"));
    const coldStop = cold.stop as ReturnType<typeof vi.fn>;
    const masked = await reg.acquire(
      opts("01HXYZCONN000000000000000A", {
        columnMasks: { "public.users": { email: "full-redact" } },
        maskSalt: "salt-1",
      }),
    );
    expect(stub.calls).toBe(2); // respawned, not reused
    expect(coldStop).toHaveBeenCalled(); // stale container evicted
    expect(masked.port).not.toBe(cold.port);
    expect(reg.size()).toBe(1);
  });

  it("respawns when the mask salt rotates", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const masks = { "public.users": { email: "full-redact" } } as ColumnMasksConfig;
    await reg.acquire(opts("01HXYZCONN000000000000000A", { columnMasks: masks, maskSalt: "s1" }));
    await reg.acquire(opts("01HXYZCONN000000000000000A", { columnMasks: masks, maskSalt: "s2" }));
    expect(stub.calls).toBe(2);
  });

  it("does NOT hand an in-flight mask-less spawn to a concurrent masked request", async () => {
    const stub = new StubSpawner();
    stub.delayMs = 40; // keep the first spawn in flight while the second arrives
    const reg = new ContainerRegistry(stub);
    // A mask-less spawn is mid-flight (e.g. a dry-run)…
    const coldP = reg.acquire(opts("01HXYZCONN000000000000000A"));
    // …when a masked request for the SAME project arrives before it lands.
    const maskedP = reg.acquire(
      opts("01HXYZCONN000000000000000A", {
        columnMasks: { "public.users": { email: "full-redact" } },
        maskSalt: "salt-1",
      }),
    );
    const [cold, masked] = await Promise.all([coldP, maskedP]);
    // The masked request must NOT be served the in-flight mask-less container —
    // it waits, then respawns with masking. (Was the bypass at spawner.ts:172.)
    expect(stub.calls).toBe(2);
    expect(masked.port).not.toBe(cold.port);
    expect(reg.size()).toBe(1); // only the masked container survives
  });

  it("bootFingerprint is canonical — column order doesn't matter (no spurious respawn)", () => {
    const a = opts("01HXYZCONN000000000000000A", {
      columnMasks: { "public.users": { email: "full-redact", ssn: "null-out" } },
      maskSalt: "s",
    });
    const b = opts("01HXYZCONN000000000000000A", {
      columnMasks: { "public.users": { ssn: "null-out", email: "full-redact" } },
      maskSalt: "s",
    });
    expect(bootFingerprint(a)).toBe(bootFingerprint(b));
    // ...but a different rule IS a different fingerprint.
    const c = opts("01HXYZCONN000000000000000A", {
      columnMasks: { "public.users": { email: "null-out" } },
      maskSalt: "s",
    });
    expect(bootFingerprint(a)).not.toBe(bootFingerprint(c));
  });

  it("bootFingerprint is canonical for object-form mask rules: key order and unset params don't matter", () => {
    // Every web instance must compute the same fingerprint for the same config,
    // or they take turns recreating the same Fly machine. A parsed rule may carry
    // its keys in any order, or an optional param set to undefined, where the
    // jsonb row simply omits it.
    const withPhoneRule = (rule: ColumnMasksConfig[string][string]) =>
      opts("01HXYZCONN000000000000000A", {
        columnMasks: { "public.users": { phone: rule } },
        maskSalt: "s",
      });
    const a = withPhoneRule({ t: "partial", keepStart: 2, keepEnd: 4 });
    const reordered = withPhoneRule({ keepEnd: 4, keepStart: 2, t: "partial" });
    const unsetParam = withPhoneRule({ t: "partial", keepStart: 2, keepEnd: 4, glyph: undefined });
    expect(bootFingerprint(reordered)).toBe(bootFingerprint(a));
    expect(bootFingerprint(unsetParam)).toBe(bootFingerprint(a));
    // ...but a changed param is a different boot config.
    const changed = withPhoneRule({ t: "partial", keepStart: 2, keepEnd: 3 });
    expect(bootFingerprint(changed)).not.toBe(bootFingerprint(a));
  });

  it("bootFingerprint changes when the DSN rotates (env can't be hot-reloaded)", () => {
    const a = opts();
    const b = { ...a, databases: [{ ...a.databases[0]!, dsn: "postgres://rotated" }] };
    expect(bootFingerprint(a)).not.toBe(bootFingerprint(b));
  });

  it("bootFingerprint changes when a database is added or renamed", () => {
    const a = opts();
    const renamed = { ...a, databases: [{ ...a.databases[0]!, name: "primary" }] };
    const added = {
      ...a,
      databases: [
        ...a.databases,
        { ...a.databases[0]!, name: "analytics", projectDatabaseId: "01HXYZANLY0000000000000000" },
      ],
    };
    expect(bootFingerprint(renamed)).not.toBe(bootFingerprint(a));
    expect(bootFingerprint(added)).not.toBe(bootFingerprint(a));
    // Database order doesn't matter.
    const reordered = { ...added, databases: [...added.databases].reverse() };
    expect(bootFingerprint(reordered)).toBe(bootFingerprint(added));
  });

  it("bootFingerprint ignores hot-reloadable policy (table_access, approvals)", () => {
    const a = opts();
    const b = {
      ...a,
      databases: [
        {
          ...a.databases[0]!,
          tableAccess: { default: "read" as const, tables: { orders: "read_write" as const } },
          approvals: {
            row_changes: true,
            whole_table_writes: true,
            schema_changes: true,
            expires_after_seconds: 1800,
            writes: true,
          },
        },
      ],
    };
    expect(bootFingerprint(b)).toBe(bootFingerprint(a));
  });

  it("bootFingerprint is a sha256 digest: no DSN, salt or gate token in cleartext", () => {
    const fp = bootFingerprint({
      ...opts("01HXYZCONN000000000000000A", {
        columnMasks: { "public.users": { email: "full-redact" } },
        maskSalt: "salt-secret",
      }),
      approvalGate: { url: "https://app/api/engine/approvals/x", token: "gate-secret" },
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain("postgres");
    expect(fp).not.toContain("secret");
  });

  it("bootFingerprint recipe is pinned: a change here needs a BOOT_FINGERPRINT_VERSION decision", () => {
    // Fly machines outlive deploys and carry this digest, so a change here
    // recreates engines. If the RECIPE changed (an input added or removed, a new
    // encoding), bump BOOT_FINGERPRINT_VERSION. If only a VALUE of an existing
    // input changed (e.g. toDatabaseEntry's maskSourceRewrite, which moves the
    // masked case below), update the digest without a bump. See the version doc.
    expect(bootFingerprint(opts())).toBe(
      "2d7cd5dfef9b9b735886ce4716c17a573ec18faa2322413f78913bc223037590",
    );
    expect(
      bootFingerprint({
        ...opts("01HXYZCONN000000000000000A", {
          columnMasks: { "public.users": { email: "full-redact" } },
          maskSalt: "s",
        }),
        approvalGate: { url: "https://app/api/engine/approvals/x", token: "t" },
      }),
    ).toBe("b4d9bc7b37feae99a9047a12e89d9ba89fc5c2e41351eed880de7cb0e304fe64");
  });

  it("an explicit empty mask map fingerprints like an absent one", () => {
    // The proxy parses masks into `{}` while other spawn paths may omit the
    // field; both boot the same engine, so they must not recreate each other's.
    const absent = opts();
    const empty = {
      ...absent,
      databases: absent.databases.map((d) => ({ ...d, columnMasks: {} })),
    };
    expect(bootFingerprint(empty)).toBe(bootFingerprint(absent));
  });

  it("respawns a warm container when the DSN was rotated on another instance", async () => {
    // Rotation ran on a different web instance, so this registry never got an
    // invalidate(). The next request carries the new password (the decrypt
    // cache is revision-keyed), so the fingerprint differs and it respawns.
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const a = opts();
    const first = await reg.acquire(a);
    await reg.acquire({ ...a, databases: [{ ...a.databases[0]!, dsn: "postgres://rotated" }] });
    expect(stub.calls).toBe(2);
    expect(first.stop).toHaveBeenCalled();
  });

  it("dedupes concurrent first-spawns via inflight mutex", async () => {
    const stub = new StubSpawner();
    stub.delayMs = 30;
    const reg = new ContainerRegistry(stub);
    const [a, b, c] = await Promise.all([
      reg.acquire(opts()),
      reg.acquire(opts()),
      reg.acquire(opts()),
    ]);
    expect(stub.calls).toBe(1);
    expect(a.port).toBe(b.port);
    expect(b.port).toBe(c.port);
  });

  it("scopes registry per project", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    await reg.acquire(opts("01HXYZCONN000000000000000A"));
    await reg.acquire(opts("01HXYZCONN000000000000000B"));
    expect(stub.calls).toBe(2);
    expect(reg.size()).toBe(2);
  });

  it("invalidate stops the container and forces respawn", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    const first = await reg.acquire(opts());
    const stopSpy = first.stop as ReturnType<typeof vi.fn>;
    await reg.invalidate("01HXYZCONN000000000000000A");
    expect(stopSpy).toHaveBeenCalled();
    expect(reg.size()).toBe(0);
    await reg.acquire(opts());
    expect(stub.calls).toBe(2);
  });

  it("recovers when first spawn rejects (clears inflight slot)", async () => {
    const stub = new StubSpawner();
    stub.failNext = true;
    const reg = new ContainerRegistry(stub);
    await expect(reg.acquire(opts())).rejects.toThrow("spawn failed");
    // inflight cleared — next acquire actually retries.
    const ok = await reg.acquire(opts());
    expect(ok.port).toBe(30002);
    expect(stub.calls).toBe(2);
  });

  it("invalidate awaits an in-flight spawn and stops the resulting container", async () => {
    // Race: a request started acquire() (which is now mid-spawn with the
    // OLD DSN env) just before rotation. invalidate() must NOT return early
    // — if it does, the spawn lands in `entries` after rotation and the
    // container keeps serving the leaked DSN until idle expiry.
    const stub = new StubSpawner();
    stub.delayMs = 30;
    const reg = new ContainerRegistry(stub);
    const spawning = reg.acquire(opts());
    // Fire invalidate while spawn is still pending.
    const invalidating = reg.invalidate("01HXYZCONN000000000000000A");
    const spawned = await spawning;
    const stopSpy = spawned.stop as ReturnType<typeof vi.fn>;
    await invalidating;
    expect(stopSpy).toHaveBeenCalled();
    expect(reg.size()).toBe(0);
  });

  it("getActive returns ActiveContainer for live projects, null otherwise", async () => {
    const stub = new StubSpawner();
    const reg = new ContainerRegistry(stub);
    expect(reg.getActive("01HXYZCONN000000000000000A")).toBeNull();

    const c = await reg.acquire(opts("01HXYZCONN000000000000000A"));
    const active = reg.getActive("01HXYZCONN000000000000000A");
    expect(active).not.toBeNull();
    expect(active?.host).toBe(c.host);
    expect(active?.port).toBe(c.port);
    expect(active?.region).toBe("eu");
    expect(active?.projectId).toBe("01HXYZCONN000000000000000A");

    expect(reg.getActive("01HXYZCONN000000000000000B")).toBeNull();
  });

  it("getActive does NOT block on an in-flight spawn (returns null)", async () => {
    // Policy hot-reload shouldn't wait on a cold start; if there's no
    // entry yet, the saver returns the durable PG state and the next
    // request reads the new policy on its own.
    const stub = new StubSpawner();
    stub.delayMs = 50;
    const reg = new ContainerRegistry(stub);
    const spawning = reg.acquire(opts("01HXYZCONN000000000000000A"));
    expect(reg.getActive("01HXYZCONN000000000000000A")).toBeNull();
    await spawning;
    expect(reg.getActive("01HXYZCONN000000000000000A")).not.toBeNull();
  });

  it("idle timer triggers stop after idleMs", async () => {
    vi.useFakeTimers();
    try {
      const stub = new StubSpawner();
      const reg = new ContainerRegistry(stub, { idleMs: 1000 });
      const first = await reg.acquire(opts());
      const stopSpy = first.stop as ReturnType<typeof vi.fn>;
      vi.advanceTimersByTime(1100);
      // Timer fires invalidate(); allow microtasks to drain.
      await Promise.resolve();
      await Promise.resolve();
      expect(stopSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
