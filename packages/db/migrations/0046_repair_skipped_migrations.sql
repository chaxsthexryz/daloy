-- Re-applies what a step-by-step upgrade skipped when the journal was out of order (decision 0101). Safe on a healthy database.
ALTER TABLE "paymongo_events" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD COLUMN IF NOT EXISTS "payload" jsonb;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paymongo_events_user_id_event_id_pk') THEN ALTER TABLE "paymongo_events" DROP CONSTRAINT IF EXISTS "paymongo_events_pkey"; ALTER TABLE "paymongo_events" ADD CONSTRAINT "paymongo_events_user_id_event_id_pk" PRIMARY KEY("user_id","event_id"); END IF; END $$;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_plan";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan" CHECK ("users"."plan" in ('preview', 'pilot', 'business', 'business_plus'));--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN IF NOT EXISTS "alert_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_external_id" ON "connections" USING btree ("external_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_sent_on" date;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"counts" jsonb NOT NULL,
	"kept" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_requests_action" CHECK ("privacy_requests"."action" in ('export', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "payment_settings" ADD COLUMN IF NOT EXISTS "receipt_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_requests_user_id_users_id_fk') THEN ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'privacy_requests_actor_id_users_id_fk') THEN ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_settings_retention') THEN ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_retention" CHECK ("payment_settings"."receipt_retention_days" between 1 and 3650); END IF; END $$;
