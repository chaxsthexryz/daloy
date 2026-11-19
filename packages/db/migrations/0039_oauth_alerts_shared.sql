ALTER TABLE "connections" ADD COLUMN "alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD COLUMN "alert_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "connections_external_id" ON "connections" USING btree ("external_id");