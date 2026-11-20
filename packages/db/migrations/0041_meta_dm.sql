ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_provider";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'meta_messenger'));--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "deliveries_provider";--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'meta_messenger'));--> statement-breakpoint
ALTER TABLE "oauth_flows" DROP CONSTRAINT IF EXISTS "oauth_flows_provider";--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_provider" CHECK ("oauth_flows"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'meta_messenger', 'gmail'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receipt_references" (
	"user_id" uuid NOT NULL,
	"normalized_ref" text NOT NULL,
	"provider" text,
	"first_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_references_user_id_normalized_ref_pk" PRIMARY KEY("user_id","normalized_ref")
);--> statement-breakpoint
ALTER TABLE "receipt_references" ADD CONSTRAINT "receipt_references_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_references" ADD CONSTRAINT "receipt_references_first_run_id_runs_id_fk" FOREIGN KEY ("first_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
