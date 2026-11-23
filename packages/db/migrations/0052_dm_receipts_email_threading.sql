ALTER TABLE "conversations" ADD COLUMN "open_due_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "email_references" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD COLUMN "source_mid" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_open_due_id_payment_dues_id_fk" FOREIGN KEY ("open_due_id") REFERENCES "public"."payment_dues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_open_due" ON "conversations" USING btree ("open_due_id") WHERE "conversations"."open_due_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_source_mid" ON "payment_claims" USING btree ("user_id","source_mid") WHERE "payment_claims"."source_mid" is not null;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_email_references" CHECK (cardinality("conversation_messages"."email_references") <= 20);
