ALTER TABLE "users" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_language" CHECK ("users"."language" in ('en', 'tl'));