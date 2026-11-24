ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_provider";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "deliveries_provider";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'meta_messenger', 'shopify', 'discord', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar', 'paymongo', 'airtable', 'notion', 'trello', 'google_drive', 'unisms', 'meta_messenger', 'shopify', 'discord', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_channel";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel" CHECK ("conversations"."channel" in ('messenger', 'instagram', 'email', 'telegram', 'whatsapp'));
