CREATE TABLE "ai_keys" (
	"user_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_auth_tag" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_keys_user_id_preset_pk" PRIMARY KEY("user_id","preset")
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Keep keys saved before this migration. Their associated data already names the provider, so they still decrypt.
INSERT INTO "ai_keys" ("user_id", "preset", "key_ciphertext", "key_iv", "key_auth_tag", "updated_at")
SELECT "user_id", "preset", "key_ciphertext", "key_iv", "key_auth_tag", "updated_at" FROM "ai_settings" WHERE "key_ciphertext" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" DROP COLUMN "key_ciphertext";--> statement-breakpoint
ALTER TABLE "ai_settings" DROP COLUMN "key_iv";--> statement-breakpoint
ALTER TABLE "ai_settings" DROP COLUMN "key_auth_tag";