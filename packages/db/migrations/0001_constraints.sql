-- Constraints Drizzle's TS schema language doesn't cleanly express:
--   1. customers.region is immutable for V1 (cross-region migration is V2).
--   2. audit_events_index.event_type CHECK matches OSS shape.
--   3. RLS on audit_events_index keyed by customer_id.
--   4. Functional partial index on payload->>'sql_fingerprint' for ATTEMPTED.
--
-- Hand-written. Registered manually in meta/_journal.json since drizzle-kit
-- only writes journal entries for schema-derived migrations. The migrator
-- splits a file into individual statements at the breakpoint marker
-- (literal sentinel two lines below); each statement runs separately.

CREATE OR REPLACE FUNCTION enforce_customer_region_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    RAISE EXCEPTION 'customer.region is immutable in V1 (cross-region migration is V2)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER customers_region_immutable
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION enforce_customer_region_immutable();
--> statement-breakpoint

ALTER TABLE audit_events_index
  ADD CONSTRAINT audit_events_index_event_type_check
  CHECK (event_type IN ('ATTEMPTED', 'DECIDED', 'EXECUTED', 'FAILED'));
--> statement-breakpoint

ALTER TABLE audit_events_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY audit_events_index_tenant_isolation
  ON audit_events_index
  USING (customer_id = current_setting('app.customer_id', true));
--> statement-breakpoint

CREATE INDEX audit_attempted_fingerprint_idx
  ON audit_events_index ((payload ->> 'sql_fingerprint'))
  WHERE event_type = 'ATTEMPTED';
