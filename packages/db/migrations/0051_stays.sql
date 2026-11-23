ALTER TABLE "resources" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_label" CHECK ("resources"."label" is null or length("resources"."label") between 1 and 80);--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "nights" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_nights" CHECK ("bookings"."nights" is null or "bookings"."nights" between 1 and 30);--> statement-breakpoint
CREATE INDEX "bookings_conversation" ON "bookings" USING btree ("conversation_id") WHERE ("bookings"."conversation_id" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_user_idempotency" ON "bookings" USING btree ("user_id","idempotency_key") WHERE ("bookings"."idempotency_key" is not null);
