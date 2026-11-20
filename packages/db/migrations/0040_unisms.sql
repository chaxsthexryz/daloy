ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "unisms_disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_provider";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms'));--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "deliveries_provider";--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms'));--> statement-breakpoint
ALTER TABLE "oauth_flows" DROP CONSTRAINT IF EXISTS "oauth_flows_provider";--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_provider" CHECK ("oauth_flows"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'gmail'));
