// One-shot pre-deploy backfill for Clerk organization publicMetadata.region.
//
// Pre-PR-29 customer rows already have a `region` column (immutable per
// the 0001 trigger), but no corresponding `publicMetadata.region` on the
// Clerk organization. After this PR ships, middleware reads region from
// the JWT — an org with no metadata claim ends up on the apex picker
// instead of their dashboard. This script writes the missing claim so
// every existing org's session pulls the right region on next refresh.
//
// Mechanism:
//   1. Page through clerkClient.organizations.getOrganizationList().
//   2. For each org, join customers by clerk_org_id (EU Neon is today's
//      single DB; that's where every existing customers row lives).
//   3. If the org's current publicMetadata.region differs from the DB
//      region, write the DB region via updateOrganizationMetadata.
//   4. Emit one REGION_CHANGED audit row per write (RLS-safe, same shape
//      as the staff endpoint).
//
// Safe re-runs: idempotent. An org whose metadata already matches the DB
// is a no-op (no Clerk write, no audit row).
//
// Usage:
//   bun run scripts/backfill-clerk-region.ts            # dry-run (default)
//   bun run scripts/backfill-clerk-region.ts --write    # actually mutate

import { createClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";

import {
  auditEventsIndex,
  customers,
  getDb,
  type Customer,
} from "@midplane-cloud/db";
import { ulid } from "ulid";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--write");

const secretKey = process.env.CLERK_SECRET_KEY;
if (!secretKey) {
  console.error("CLERK_SECRET_KEY is not set");
  process.exit(1);
}
const clerk = createClerkClient({ secretKey });

// The backfill always runs against EU Neon — that's where every existing
// customer row currently lives, regardless of the customer.region value.
// Post-launch, new US-region signups land in US Neon directly; this
// script is for the pre-launch population only.
const db = getDb("eu");

interface BackfillStats {
  scanned: number;
  matched: number;
  wouldWrite: number;
  written: number;
  noCustomer: number;
  errors: number;
}

const ACTOR_SYSTEM = "system.backfill";
const CUSTOMER_ID_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function emitBackfillAudit(
  customer: Customer,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!CUSTOMER_ID_ULID_RE.test(customer.id)) {
    throw new Error(`backfill: bad customer id ${customer.id}`);
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL app.customer_id = '${customer.id}'`),
    );
    await tx.insert(auditEventsIndex).values({
      id: ulid(),
      customerId: customer.id,
      tenantId: customer.id,
      region: customer.region,
      queryId: ulid(),
      database: "main",
      ts: new Date(),
      eventType: "REGION_CHANGED",
      payload,
      actorClerkUserId: ACTOR_SYSTEM,
    });
  });
}

async function backfill(): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    matched: 0,
    wouldWrite: 0,
    written: 0,
    noCustomer: 0,
    errors: 0,
  };

  const limit = 100;
  let offset = 0;
  while (true) {
    const page = await clerk.organizations.getOrganizationList({
      limit,
      offset,
    });
    if (page.data.length === 0) break;

    for (const org of page.data) {
      stats.scanned += 1;

      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.clerkOrgId, org.id))
        .limit(1);
      const customer = rows[0];
      if (!customer) {
        stats.noCustomer += 1;
        console.log(
          JSON.stringify({
            event: "backfill.skip_no_customer",
            orgId: org.id,
            orgSlug: org.slug,
          }),
        );
        continue;
      }
      stats.matched += 1;

      const currentClaim = (
        org.publicMetadata as { region?: unknown } | null
      )?.region;
      if (currentClaim === customer.region) continue;

      if (dryRun) {
        stats.wouldWrite += 1;
        console.log(
          JSON.stringify({
            event: "backfill.would_write",
            orgId: org.id,
            from: currentClaim ?? null,
            to: customer.region,
          }),
        );
        continue;
      }

      try {
        await clerk.organizations.updateOrganizationMetadata(org.id, {
          publicMetadata: { region: customer.region },
        });
        await emitBackfillAudit(customer, {
          from: currentClaim ?? null,
          to: customer.region,
          source: "backfill",
        });
        stats.written += 1;
        console.log(
          JSON.stringify({
            event: "backfill.wrote",
            orgId: org.id,
            from: currentClaim ?? null,
            to: customer.region,
          }),
        );
      } catch (err) {
        stats.errors += 1;
        console.error(
          JSON.stringify({
            event: "backfill.error",
            orgId: org.id,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    if (page.data.length < limit) break;
    offset += page.data.length;
  }

  return stats;
}

const stats = await backfill();
console.log(
  JSON.stringify({
    event: "backfill.done",
    mode: dryRun ? "dry-run" : "write",
    ...stats,
  }),
);
process.exit(stats.errors > 0 ? 1 : 0);
