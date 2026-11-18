CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_type" CHECK ("uploads"."type" in ('jpeg', 'png', 'webp', 'heic', 'pdf')),
	CONSTRAINT "uploads_size" CHECK ("uploads"."size" between 1 and 5242880)
);
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_provider";--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploads_created" ON "uploads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "uploads_run" ON "uploads" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive'));