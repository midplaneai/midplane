import type { Region } from "@midplane-cloud/kms";

// Single-tenant self-host seam. MIDPLANE_SELF_HOST=1 selects the standalone,
// keyless, single-DB build a self-hoster runs against one Postgres + a local
// engine. Unset (the default) is the multi-tenant, region-resident CLOUD, which
// MUST stay byte-for-byte unchanged. Every self-host branch in the app gates on
// isSelfHost() — one read, one seam.
//
// PURE by contract: this module is imported by middleware.ts (Edge runtime), so
// it must never pull a Node-only runtime dependency (no getDb, no postgres, no
// fs/os). It holds the flag + the fixed identity constants only — all
// value-free except the env read. The DB-touching bootstrap
// (ensureImplicitCustomer) and the implicit-customer read live in customer.ts.
// Same purity rule region-routing.ts follows so middleware stays bundlable.

/** True when this process is the single-tenant self-host build. */
export function isSelfHost(): boolean {
  return process.env.MIDPLANE_SELF_HOST === "1";
}

/** The one region token self-host pins everything to.
 *
 *  Self-host has ONE database — getDb() ignores its region argument — but the
 *  audit pipeline still STAMPS and FILTERS a `region` column (the indexer
 *  writes it; every /audit read does `AND region = …`). Writes and reads must
 *  therefore agree on a single value. We reuse "eu" rather than widening the
 *  Region union to a third value, which would ripple through REGION_HOST,
 *  regionToAws, and every _EU/_US env-var name for no benefit in a one-region
 *  build. The implicit customer row carries this region and bootRegion()
 *  returns it, so the indexer's stamp and the dashboard's filter line up. */
export const SELF_HOST_REGION: Region = "eu";

/** The implicit customer's id — bound on EVERY customer_id-scoped transaction
 *  in self-host exactly as the cloud binds the real id. A fixed, well-known
 *  ULID: 26 chars in the Crockford alphabet so it passes the ULID_RE guard
 *  (`^[0-9A-HJKMNP-TV-Z]{26}$`) that every `SET LOCAL app.customer_id` site
 *  validates before inlining. If this row is absent or the id drifts,
 *  current_setting('app.customer_id','t') returns '' and the RLS policy hides
 *  every row — a blank audit log, silently. ensureImplicitCustomer() seeds the
 *  row at boot so that can't happen. */
export const SELF_HOST_CUSTOMER_ID = "00000000000000000000000000";

/** The implicit Better Auth organization id — the customers.org_id target.
 *  One implicit org maps to the one implicit customer. */
export const SELF_HOST_ORG_ID = "self-host-org";
