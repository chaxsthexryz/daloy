CREATE TABLE "ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preset" text NOT NULL,
	"model" text NOT NULL,
	"key_ciphertext" text,
	"key_iv" text,
	"key_auth_tag" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;