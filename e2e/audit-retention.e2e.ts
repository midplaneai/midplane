// Real-Postgres e2e for the audit retention window (pricing).
//
// What this proves (codex #7/#8 — the privacy boundary that unit tests can
// only check at the SQL-shape level): with a plan's retention window applied,
// rows older than the window are genuinely invisible to BOTH the list read
// and the single-row deep-link read, against a real Postgres. A subtle clamp
// bug (wrong comparison, wrong interval) would let a Free customer read audit
// history they shouldn't — exactly what this catches.
//
// Why the query logic is inlined (not imported from apps/web/src/lib/audit):
// same reason as audit-isolation.e2e.ts — Playwright's TS loader resolves the
// relative `.ts` import as CJS and breaks the named ESM imports. The clamp
// under test mirrors lib/audit.ts's `retentionSince` + `gte(ts, since)` /
// `ts >= since` exactly; vitest (audit.test.ts) covers the lib's SQL shape.

import { expect, test } from "@playwright/test";
import { and, eq, gte, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  customers,
  getDb,
  type NewAuditEvent,
} from "@midplane-cloud/db";

test.skip(
  !process.env.DATABASE_URL_EU,
  "DATABASE_URL_EU must be set for the audit retention suite (real Postgres)",
);

const REGION = "eu" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

let custId: string;
let recentId: string;
let tenDayId: string;
let fortyDayId: string;

test.beforeAll(async () => {
  const db = getDb("eu");
  custId = ulid();
  recentId = ulid();
  tenDayId = ulid();
  fortyDayId = ulid();

  await db.insert(customers).values({
    id: custId,
    clerkOrgId: `org_e2e-retention-${custId}`,
    email: `e2e-retention-${custId}@example.test`,
    region: REGION,
  });

  const now = Date.now();
  const rows: NewAuditEvent[] = [
    seedRow(recentId, custId, "ATTEMPTED", now - 1 * DAY_MS), // inside 7d + 30d
    seedRow(tenDayId, custId, "ATTEMPTED", now - 10 * DAY_MS), // outside 7d, inside 30d
    seedRow(fortyDayId, custId, "ATTEMPTED", now - 40 * DAY_MS), // outside both
  ];
  await insertScoped(custId, rows);
});

test.afterAll(async () => {
  const db = getDb("eu");
  await deleteScoped(custId);
  if (custId) await db.delete(customers).where(eq(customers.id, custId));
});

test("Free (7-day) window hides rows older than 7 days", async () => {
  const ids = await listIds(custId, 7);
  expect(ids).toContain(recentId);
  expect(ids).not.toContain(tenDayId);
  expect(ids).not.toContain(fortyDayId);
});

test("Pro/Team (30-day) window shows the 10-day row but not the 40-day row", async () => {
  const ids = await listIds(custId, 30);
  expect(ids).toContain(recentId);
  expect(ids).toContain(tenDayId);
  expect(ids).not.toContain(fortyDayId);
});

test("deep-link to an out-of-window event returns null (the empty-state path)", async () => {
  // Free user deep-linking the 10-day-old row id → clamped read returns null,
  // which is what renders "no longer exists or is outside your retention
  // window" on /audit/[id].
  expect(await getByIdClamped(custId, tenDayId, 7)).toBeNull();
  // The same id IS visible under the 30-day window — proves the clamp is the
  // reason it was hidden, not a missing row.
  expect(await getByIdClamped(custId, tenDayId, 30)).not.toBeNull();
});

// --- inline query helpers (mirror apps/web/src/lib/audit.ts) ---------------

function retentionSince(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * DAY_MS);
}

async function listIds(
  customerId: string,
  retentionDays: number,
): Promise<string[]> {
  const since = retentionSince(retentionDays);
  const db = getDb("eu");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    const rows = await tx
      .select({ id: auditEventsIndex.id })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, REGION),
          gte(auditEventsIndex.ts, since),
        ),
      );
    return rows.map((r) => r.id);
  });
}

async function getByIdClamped(
  customerId: string,
  id: string,
  retentionDays: number,
): Promise<{ id: string } | null> {
  const since = retentionSince(retentionDays);
  const db = getDb("eu");
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${customerId}'`));
    const rows = await tx
      .select({ id: auditEventsIndex.id })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.id, id),
          gte(auditEventsIndex.ts, since),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

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

function seedRow(
  id: string,
  customerId: string,
  eventType: NewAuditEvent["eventType"],
  tsMs: number,
): NewAuditEvent {
  return {
    id,
    customerId,
    tenantId: "tenant_retention",
    region: REGION,
    queryId: `q-${id}`,
    agentIdentity: "playwright-e2e",
    ts: new Date(tsMs),
    eventType,
    payload: { sql_fingerprint: `seed-${eventType.toLowerCase()}` },
    schemaVersion: 1,
  };
}
