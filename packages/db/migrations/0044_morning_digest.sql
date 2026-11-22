ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_sent_on" date;