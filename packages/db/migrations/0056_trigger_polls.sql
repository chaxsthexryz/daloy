CREATE TABLE "trigger_polls" (
	"workflow_id" uuid PRIMARY KEY NOT NULL,
	"source" text,
	"cursor" jsonb,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_until" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"problem" text,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "trigger_polls" ADD CONSTRAINT "trigger_polls_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_polls_due" ON "trigger_polls" USING btree ("next_poll_at");