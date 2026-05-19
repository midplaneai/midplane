-- Switch tenant identity from per-Clerk-user to per-Clerk-organization. Pre-
-- launch rename — every Midplane customer is now one Clerk organization,
-- with members as actors.
--
-- Two changes:
--
--   1. customers.clerk_user_id  →  customers.clerk_org_id (and the unique
--      constraint name moves with it). currentCustomer() resolves via
--      auth().orgId; org auto-creation is handled in the Clerk dashboard
--      so every signed-in user has an active org.
--
--   2. audit_events_index gains actor_clerk_user_id (nullable). The org is
--      the tenant; the user is the actor. Engine-side query events
--      (ATTEMPTED/DECIDED/EXECUTED/FAILED) leave it null — no human in the
--      loop. Cloud-driven events (POLICY_RELOADED, future write actions)
--      stamp the Clerk user that triggered them, so an audit reviewer can
--      answer "who reloaded the policy at 14:03?".
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE customers RENAME COLUMN clerk_user_id TO clerk_org_id;
--> statement-breakpoint
ALTER TABLE customers RENAME CONSTRAINT customers_clerk_user_id_unique TO customers_clerk_org_id_unique;
--> statement-breakpoint
ALTER TABLE audit_events_index ADD COLUMN actor_clerk_user_id text;
