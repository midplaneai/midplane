-- Provider-neutral identity columns + the founder/internal plan override.
--
-- Renames the two Clerk-named identity columns to provider-neutral names
-- (mcp_tokens.created_by_user_id was already neutral) and adds the manual
-- plan-override lever removed when Clerk's has() went away. Born-open: the
-- schema shouldn't name a vendor.
--
--   customers.clerk_org_id                 -> customers.org_id (+ uniq constraint)
--   audit_events_index.actor_clerk_user_id -> audit_events_index.actor_user_id
--   customers.plan_override                 NEW (nullable; free|pro|team)
--
-- audit_events_index is append-only + RLS-guarded on customer_id; the actor
-- rename touches neither the policy nor any index, so it's a pure column
-- rename. plan_override carries no DB CHECK (TS enum only, mirroring region).
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE customers RENAME COLUMN clerk_org_id TO org_id;
--> statement-breakpoint
ALTER TABLE customers
  RENAME CONSTRAINT customers_clerk_org_id_unique TO customers_org_id_unique;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN plan_override text;
--> statement-breakpoint
ALTER TABLE audit_events_index
  RENAME COLUMN actor_clerk_user_id TO actor_user_id;
