ALTER TABLE "ai_settings" ADD COLUMN "thinking" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_thinking" CHECK ("ai_settings"."thinking" in ('off', 'low', 'medium', 'high'));
