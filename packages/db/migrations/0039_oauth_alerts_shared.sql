ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN IF NOT EXISTS "alert_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_external_id" ON "connections" USING btree ("external_id");