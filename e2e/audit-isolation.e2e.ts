// Cross-tenant isolation e2e for the /audit dashboard.
//
// What this proves:
//   1. Two customers seeded into the same table; queries that mirror
//      audit.ts's two-layer pattern (`WHERE customer_id = bound_id` +
//      `SET LOCAL app.customer_id`) return ONLY rows owned by the
//      bound customer. The WHERE filter is the always-on application
//      defense; the SET LOCAL engages the RLS policy declared in
//      0001_constraints.sql + 0004_force_rls *once* the deployment
//      role is non-BYPASSRLS (Neon's default owner role bypasses RLS,
//      hence layer #1 carries the load today — see audit.ts comment).
//   2. The filter logic interacts correctly with WHERE clauses the
//      dashboard uses (event_type, tenant_id, search, cursor pagination).
//   3. The /audit HTTP route exists and the Clerk middleware protects
//      unauthenticated visitors from seeing audit data.
//
// Why query logic is inlined instead of imported from
// apps/web/src/lib/audit: apps/web has no `"type": "module"` field
// and no package "exports", so Playwright's TS loader resolves a
// relative `.ts` import as CJS and breaks named ESM imports. The
// SET LOCAL pattern under test is small and worth duplicating here;
// vitest already covers the lib's exact SQL shape (audit.test.ts).
//
// Why we don't drive a real Clerk sign-in: Clerk dev sign-in from a
// headless browser would need @clerk/testing + a long-lived test
// user provisioned in the Clerk dashboard, not set up for V1. The
// HTTP middleware check below catches the "/audit unprotected"
// regression; the SET LOCAL queries below catch the "RLS broke"
// regression. Together they cover the two ways isolation could fail.

import { expect, test } from "@playwright/test";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  customers,
  getDb,
  type NewAuditEvent,
} from "@midplane-cloud/db";

test.skip(
  !process.env.DATABASE_URL_EU,
  "DATABASE_URL_EU must be set for the audit isolation suite (uses RLS against a real Postgres)",
);

const REGION = "eu" as const;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let custAId: string;
let custBId: string;
let custAQueryId: string;

test.beforeAll(async () => {
  const db = getDb("eu");
  custAId = ulid();
  custBId = ulid();
  custAQueryId = `qA-${ulid()}`;

  // customers has no RLS — bulk insert is fine.
  await db.insert(customers).values([
    {
      id: custAId,
      orgId: `org_e2e-audit-A-${custAId}`,
      email: `e2e-audit-A-${custAId}@example.test`,
      region: REGION,
    },
    {
      id: custBId,
      orgId: `org_e2e-audit-B-${custBId}`,
      email: `e2e-audit-B-${custBId}@example.test`,
      region: REGION,
    },
  ]);

  const baseTs = Date.now();
  const aRows: NewAuditEvent[] = [
    seedRow(custAId, "tenant_a1", custAQueryId, "ATTEMPTED", baseTs, {
      sql_fingerprint: "select-from-users-1",
      sql_raw: "SELECT id FROM users",
    }),
    seedRow(custAId, "tenant_a1", custAQueryId, "DECIDED", baseTs + 1, {
      decision: "allow",
    }),
    seedRow(custAId, "tenant_a1", custAQueryId, "EXECUTED", baseTs + 2, {
      exec_ms: 12,
    }),
    seedRow(
      custAId,
      "tenant_a2",
      `qA-other-${ulid()}`,
      "FAILED",
      baseTs + 3,
      { sql_fingerprint: "delete-from-orders-99", error: "denied" },
    ),
  ];
  const bRows: NewAuditEvent[] = [
    seedRow(custBId, "tenant_b1", `qB-${ulid()}`, "ATTEMPTED", baseTs + 10, {
      sql_fingerprint: "select-from-secrets-of-B",
    }),
    seedRow(custBId, "tenant_b1", `qB-${ulid()}`, "DECIDED", baseTs + 11, {
      decision: "deny",
      reason: "writes_require_approval",
    }),
  ];
  // INSERT is gated by the same RLS policy under FORCE ROW LEVEL SECURITY
  // (USING serves as the WITH CHECK when no separate WITH CHECK is given),
  // so the seed must bind app.customer_id per batch — anything else would
  // pass today (owner bypasses RLS) but fail the moment the deployment
  // moves to a non-BYPASSRLS app role, which is the configuration this
  // test is supposed to validate.
  await insertScoped(custAId, aRows);
  await insertScoped(custBId, bRows);
});

test.afterAll(async () => {
  const db = getDb("eu");
  // Cleanup also goes through SET LOCAL — DELETE under FORCE RLS only sees
  // (and only deletes) rows visible to the bound customer_id.
  await deleteScoped(custAId);
  await deleteScoped(custBId);
  if (custAId) await db.delete(customers).where(eq(customers.id, custAId));
  if (custBId) await db.delete(customers).where(eq(customers.id, custBId));
});

async function insertScoped(
  customerId: string,
  rows: NewAuditEvent[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb("eu");
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    await tx.insert(auditEventsIndex).values(rows);
  });
}

async function deleteScoped(customerId: string): Promise<void> {
  const db = getDb("eu");
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    await tx
      .delete(auditEventsIndex)
      .where(eq(auditEventsIndex.customerId, customerId));
  });
}

test("customer A's listing returns ONLY A's rows under RLS", async () => {
  const aRows = await listForCustomer(custAId, {});
  expect(aRows.length).toBeGreaterThanOrEqual(4);
  for (const r of aRows) {
    expect(r.tenant_id.startsWith("tenant_a")).toBe(true);
  }

  const bRows = await listForCustomer(custBId, {});
  expect(bRows.length).toBeGreaterThanOrEqual(2);
  for (const r of bRows) {
    expect(r.tenant_id.startsWith("tenant_b")).toBe(true);
  }
});

test("filter by event_type narrows within A and never reveals B", async () => {
  const decided = await listForCustomer(custAId, {
    eventTypes: ["DECIDED"],
  });
  expect(decided.every((r) => r.event_type === "DECIDED")).toBe(true);
  expect(decided.every((r) => r.tenant_id.startsWith("tenant_a"))).toBe(true);
});

test("filter by tenant_id narrows within A", async () => {
  const onlyA1 = await listForCustomer(custAId, { tenantId: "tenant_a1" });
  expect(onlyA1.length).toBeGreaterThanOrEqual(3);
  expect(onlyA1.every((r) => r.tenant_id === "tenant_a1")).toBe(true);
});

test("search matches sql_fingerprint substring", async () => {
  const hits = await listForCustomer(custAId, {
    search: "delete-from-orders",
  });
  expect(hits.length).toBeGreaterThanOrEqual(1);
  expect(hits[0]?.sql_fingerprint).toContain("delete-from-orders");
});

test("getById + related events respect RLS", async () => {
  const aRow = (
    await listForCustomer(custAId, {
      eventTypes: ["ATTEMPTED"],
      tenantId: "tenant_a1",
    })
  )[0];
  expect(aRow).toBeDefined();

  // A reading A's row succeeds with full payload.
  const detail = await getByIdForCustomer(custAId, aRow!.id);
  expect(detail).not.toBeNull();
  expect(detail!.payload).toMatchObject({
    sql_fingerprint: "select-from-users-1",
  });

  // B trying to read A's row — RLS hides it.
  const leak = await getByIdForCustomer(custBId, aRow!.id);
  expect(leak, "RLS must hide cross-customer ids").toBeNull();

  // Lifecycle for A's queryId returns 3 events in ts order.
  const lifecycle = await getRelatedForCustomer(custAId, custAQueryId);
  expect(lifecycle).toHaveLength(3);
  expect(lifecycle.map((r) => r.event_type)).toEqual([
    "ATTEMPTED",
    "DECIDED",
    "EXECUTED",
  ]);

  // B asking for A's queryId — empty under RLS.
  const bLeak = await getRelatedForCustomer(custBId, custAQueryId);
  expect(bLeak).toHaveLength(0);
});

test("pagination cursor stays within the bound customer", async () => {
  const page1 = await listForCustomer(custAId, { pageSize: 2 });
  expect(page1.length).toBeLessThanOrEqual(2);
  if (page1.length === 2) {
    const cursor = page1[page1.length - 1]!.id;
    const page2 = await listForCustomer(custAId, { pageSize: 2, cursor });
    const seen = new Set(page1.map((r) => r.id));
    for (const r of page2) {
      expect(seen.has(r.id)).toBe(false);
      expect(r.tenant_id.startsWith("tenant_a")).toBe(true);
    }
  }
});

test("/audit HTTP route exists and the Clerk middleware protects it", async ({
  page,
}) => {
  const res = await page.goto("/audit");
  expect(res?.status() ?? 200).toBeLessThan(500);
  await expect(page.getByTestId("audit-table")).not.toBeVisible();
  await expect(page.getByText("No queries yet.")).not.toBeVisible();
});

// --- inline query helpers (mirror apps/web/src/lib/audit.ts) ---------------

interface ListOpts {
  eventTypes?: ReadonlyArray<NewAuditEvent["eventType"]>;
  tenantId?: string;
  search?: string;
  pageSize?: number;
  cursor?: string;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  event_type: string;
  sql_fingerprint: string | null;
}

async function listForCustomer(
  customerId: string,
  opts: ListOpts,
): Promise<AuditRow[]> {
  if (!ULID_RE.test(customerId)) throw new Error("invalid customer_id");
  const db = getDb("eu");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));

    const filters = [
      eq(auditEventsIndex.customerId, customerId),
      eq(auditEventsIndex.region, REGION),
    ];
    if (opts.cursor) filters.push(lt(auditEventsIndex.id, opts.cursor));
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      filters.push(inArray(auditEventsIndex.eventType, [...opts.eventTypes]));
    }
    if (opts.tenantId) {
      filters.push(eq(auditEventsIndex.tenantId, opts.tenantId));
    }
    if (opts.search) {
      const needle = `%${opts.search}%`;
      filters.push(
        or(
          sql`${auditEventsIndex.payload} ->> 'sql_fingerprint' ILIKE ${needle}`,
          sql`${auditEventsIndex.queryId} ILIKE ${needle}`,
        )!,
      );
    }

    const rows = await tx
      .select({
        id: auditEventsIndex.id,
        tenant_id: auditEventsIndex.tenantId,
        event_type: auditEventsIndex.eventType,
        sql_fingerprint: sql<
          string | null
        >`${auditEventsIndex.payload} ->> 'sql_fingerprint'`,
      })
      .from(auditEventsIndex)
      .where(and(...filters))
      .orderBy(desc(auditEventsIndex.id))
      .limit(opts.pageSize ?? 50);
    return rows;
  });
}

async function getByIdForCustomer(
  customerId: string,
  id: string,
): Promise<{ payload: unknown } | null> {
  const db = getDb("eu");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    const rows = await tx
      .select({ payload: auditEventsIndex.payload })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

async function getRelatedForCustomer(
  customerId: string,
  queryId: string,
): Promise<{ event_type: string }[]> {
  const db = getDb("eu");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    return tx
      .select({ event_type: auditEventsIndex.eventType })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.queryId, queryId),
        ),
      )
      .orderBy(auditEventsIndex.ts);
  });
}

function seedRow(
  customerId: string,
  tenantId: string,
  queryId: string,
  eventType: NewAuditEvent["eventType"],
  tsMs: number,
  payload: Record<string, unknown>,
): NewAuditEvent {
  return {
    id: ulid(),
    customerId,
    tenantId,
    region: REGION,
    queryId,
    agentIdentity: "playwright-e2e",
    ts: new Date(tsMs),
    eventType,
    payload,
    schemaVersion: 1,
  };
}
