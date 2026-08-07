CREATE TABLE "write_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_database_id" text NOT NULL,
	"region" text NOT NULL,
	"grant_key" text NOT NULL,
	"sql_text" text NOT NULL,
	"intent" text NOT NULL,
	"statement_type" text NOT NULL,
	"tables_touched" text[] NOT NULL,
	"query_id" text NOT NULL,
	"agent_name" text,
	"mcp_token_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "approvals" jsonb DEFAULT '{"writes":false,"expires_after_seconds":1800}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "write_approvals" ADD CONSTRAINT "write_approvals_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_approvals" ADD CONSTRAINT "write_approvals_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_approvals" ADD CONSTRAINT "write_approvals_database_fk" FOREIGN KEY ("project_database_id") REFERENCES "public"."project_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "write_approvals_queue_idx" ON "write_approvals" USING btree ("customer_id","region","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "write_approvals_pending_uq" ON "write_approvals" USING btree ("project_database_id","grant_key") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "write_approvals_grant_idx" ON "write_approvals" USING btree ("project_database_id","grant_key","status");