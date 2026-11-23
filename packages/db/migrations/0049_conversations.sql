CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"text" text NOT NULL,
	"mid" text,
	"run_id" uuid,
	"upload_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_conversation_id_mid_unique" UNIQUE("conversation_id","mid"),
	CONSTRAINT "conversation_messages_direction" CHECK ("conversation_messages"."direction" in ('in', 'out', 'staff')),
	CONSTRAINT "conversation_messages_text" CHECK (length("conversation_messages"."text") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'bot' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"staff_until" timestamp with time zone,
	"notice_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_user_id_channel_external_id_unique" UNIQUE("user_id","channel","external_id"),
	CONSTRAINT "conversations_channel" CHECK ("conversations"."channel" in ('messenger', 'instagram', 'email')),
	CONSTRAINT "conversations_status" CHECK ("conversations"."status" in ('bot', 'staff', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "conversation_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "staff_quiet_hours" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_at" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_conversation" ON "runs" USING btree ("conversation_id") WHERE "runs"."conversation_id" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_conversation_retention" CHECK ("users"."conversation_retention_days" between 1 and 3650);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_staff_quiet" CHECK ("users"."staff_quiet_hours" between 1 and 168);