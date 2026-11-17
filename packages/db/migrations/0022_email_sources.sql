CREATE TABLE "email_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"host" text NOT NULL,
	"username" text NOT NULL,
	"folder" text NOT NULL,
	"ciphertext" text,
	"iv" text,
	"auth_tag" text,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"listening" boolean DEFAULT false NOT NULL,
	"uid_validity" text,
	"last_uid" bigint,
	"claim_id" uuid,
	"claim_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sources_workflow_id_unique" UNIQUE("workflow_id"),
	CONSTRAINT "email_sources_status" CHECK ("email_sources"."status" in ('pending', 'active', 'failed', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "email_sources" ADD CONSTRAINT "email_sources_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;