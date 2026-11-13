CREATE TABLE "connections" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"account" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_iv" text NOT NULL,
	"credential_auth_tag" text NOT NULL,
	"destination" jsonb,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack')),
	CONSTRAINT "connections_status" CHECK ("connections"."status" in ('active', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"check_first" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_run_id_step_id_unique" UNIQUE("run_id","step_id"),
	CONSTRAINT "deliveries_state" CHECK ("deliveries"."state" in ('queued', 'sending', 'delivered', 'needs_review', 'failed')),
	CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "deliveries" USING btree ("next_attempt_at") WHERE "deliveries"."state" in ('queued', 'sending');