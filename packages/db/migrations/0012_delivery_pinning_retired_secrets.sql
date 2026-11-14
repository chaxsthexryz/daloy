CREATE SEQUENCE "public"."sheet_meta_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "retired_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "pinned_account" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "pinned_destination" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sheet_meta_id" integer;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sheet_meta_value" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sheet_meta_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retired_secrets" ADD CONSTRAINT "retired_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;