ALTER TABLE "connections" DROP CONSTRAINT "connections_provider";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_provider";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'airtable', 'notion', 'trello'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'airtable', 'notion', 'trello'));