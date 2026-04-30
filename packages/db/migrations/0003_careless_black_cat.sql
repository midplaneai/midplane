-- Cursor rows are caches of the indexer's bookmark — rebuilding from
-- empty on the next tick is correct behavior (re-indexes from id="",
-- onConflictDoNothing on audit_events_index makes that idempotent).
-- Clearing here lets us add customer_id NOT NULL without a backfill.
DELETE FROM "indexer_cursors";--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "customer_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "indexer_cursors_customer_id_idx" ON "indexer_cursors" USING btree ("customer_id");