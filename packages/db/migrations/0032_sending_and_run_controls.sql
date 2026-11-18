ALTER TABLE "triggers" ADD COLUMN "legacy_signature_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "resumed_at" timestamp with time zone;