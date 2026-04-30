CREATE TABLE "indexer_cursors" (
	"mcp_token" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"last_id" text DEFAULT '' NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "indexer_cursors_region_idx" ON "indexer_cursors" USING btree ("region");