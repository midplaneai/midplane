-- Rename region values from airport codes (fra/iad) to jurisdiction codes
-- (eu/us). This is purely a data rename of an existing text column — no
-- schema reshape — but it crosses a security boundary: the env-mode AAD is
-- `customerId|region`, so any existing ciphertext encoded with the airport
-- code becomes unrecoverable after this migration.
--
-- Acceptable because midplane-cloud has not been deployed beyond local dev;
-- any seeded dev rows can be wiped + re-entered. Re-running on a populated
-- production DB would require a re-encrypt pass under a feature flag — out
-- of scope here.
--
-- The kms_key_id prefix moves with the region: `env:fra` -> `env:eu`,
-- `env:iad` -> `env:us`. The router gates env-mode on `kmsKeyId.startsWith
-- ("env:")` so the prefix value just needs to round-trip into the env-mode
-- envKeys lookup; both halves are renamed in the same commit.
--
-- Tables touched (every column typed text-as-region): customers.region,
-- connections.region, audit_events_index.region, indexer_cursors.region,
-- plus connection_databases.kms_key_id.

-- customers.region: parent of the (id, region) composite FK that connections
-- piggybacks on, so update it first.
UPDATE "customers" SET "region" = 'eu' WHERE "region" = 'fra';
--> statement-breakpoint
UPDATE "customers" SET "region" = 'us' WHERE "region" = 'iad';
--> statement-breakpoint

-- connections.region: must match its customer's region (enforced by the
-- composite FK declared in 0000). Updating in the same migration window
-- keeps the constraint satisfied at commit boundary.
UPDATE "connections" SET "region" = 'eu' WHERE "region" = 'fra';
--> statement-breakpoint
UPDATE "connections" SET "region" = 'us' WHERE "region" = 'iad';
--> statement-breakpoint

-- audit_events_index.region: partition-prune key on every dashboard query.
-- Renaming preserves index covering since it's the same text column.
UPDATE "audit_events_index" SET "region" = 'eu' WHERE "region" = 'fra';
--> statement-breakpoint
UPDATE "audit_events_index" SET "region" = 'us' WHERE "region" = 'iad';
--> statement-breakpoint

-- indexer_cursors.region: indexer's per-region drain bookmark.
UPDATE "indexer_cursors" SET "region" = 'eu' WHERE "region" = 'fra';
--> statement-breakpoint
UPDATE "indexer_cursors" SET "region" = 'us' WHERE "region" = 'iad';
--> statement-breakpoint

-- connection_databases.kms_key_id: rename the env-mode prefix in lockstep
-- with the region rename. Production rows would carry AWS KMS ARNs here
-- (no rename needed) — this only touches env: prefixes used in dev/local.
UPDATE "connection_databases"
  SET "kms_key_id" = 'env:eu'
  WHERE "kms_key_id" = 'env:fra';
--> statement-breakpoint
UPDATE "connection_databases"
  SET "kms_key_id" = 'env:us'
  WHERE "kms_key_id" = 'env:iad';
