CREATE TABLE "business_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"business_name" text,
	"website" text,
	"inquiry_email" text,
	"reply_to" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_senders" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"password_ciphertext" text,
	"password_iv" text,
	"password_auth_tag" text,
	"verify_token_hash" text,
	"verify_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"last_tested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_senders_verify_token_hash_unique" UNIQUE("verify_token_hash"),
	CONSTRAINT "mail_senders_status" CHECK ("mail_senders"."status" in ('unverified', 'active', 'failed', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD CONSTRAINT "mail_senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;