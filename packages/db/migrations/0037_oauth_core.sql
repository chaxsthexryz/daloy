CREATE TABLE "oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"verifier_ciphertext" text,
	"verifier_iv" text,
	"verifier_auth_tag" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_flows_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "oauth_flows_provider" CHECK ("oauth_flows"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "auth_method" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
-- Backfill by provider (decision 0058). Outlook already holds a refresh token from Microsoft consent.
UPDATE "connections" SET "auth_method" = CASE "provider" WHEN 'google_sheets' THEN 'service_account' WHEN 'google_calendar' THEN 'service_account' WHEN 'google_drive' THEN 'service_account' WHEN 'teams' THEN 'webhook_url' WHEN 'outlook' THEN 'oauth' ELSE 'token' END;--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "auth_method" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "scopes" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "pinned_external_id" text;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "auth_method" text DEFAULT 'app_password' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "scopes" text;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_workspace_id_users_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_flows_expires" ON "oauth_flows" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_auth_method" CHECK ("connections"."auth_method" in ('token', 'service_account', 'oauth', 'webhook_url'));--> statement-breakpoint
ALTER TABLE "mail_senders" ADD CONSTRAINT "mail_senders_auth_method" CHECK ("mail_senders"."auth_method" in ('app_password', 'oauth'));