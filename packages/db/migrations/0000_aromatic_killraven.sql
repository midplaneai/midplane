CREATE TABLE "audit_events_index" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"region" text NOT NULL,
	"query_id" text NOT NULL,
	"agent_identity" text,
	"ts" timestamp with time zone NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"region" text NOT NULL,
	"encrypted_dsn" "bytea" NOT NULL,
	"kms_key_id" text NOT NULL,
	"mcp_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_kms_success_at" timestamp with time zone,
	CONSTRAINT "connections_mcp_token_unique" UNIQUE("mcp_token")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"region" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "customers_id_region_uq" UNIQUE("id","region")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_customer_region_fk" FOREIGN KEY ("customer_id","region") REFERENCES "public"."customers"("id","region") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_customer_region_ts_idx" ON "audit_events_index" USING btree ("customer_id","region","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_customer_region_type_ts_idx" ON "audit_events_index" USING btree ("customer_id","region","event_type","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_query_id_idx" ON "audit_events_index" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX "connections_customer_id_idx" ON "connections" USING btree ("customer_id");