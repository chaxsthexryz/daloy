ALTER TABLE "runs" ADD COLUMN "ai_live" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "test_choices" jsonb;