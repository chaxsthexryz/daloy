CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"reply" text,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_topic" CHECK ("feedback"."topic" in ('bug', 'idea', 'question', 'billing', 'other')),
	CONSTRAINT "feedback_status" CHECK ("feedback"."status" in ('new', 'replied', 'closed')),
	CONSTRAINT "feedback_message" CHECK (length("feedback"."message") between 1 and 2000),
	CONSTRAINT "feedback_reply" CHECK ("feedback"."reply" is null or length("feedback"."reply") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_action";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_users_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_status_created" ON "feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_workspace_created" ON "feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_action" CHECK ("admin_actions"."action" in ('plan', 'shared_mail', 'ai', 'ai_thinking', 'feedback_reply', 'feedback_close'));