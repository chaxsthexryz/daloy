CREATE TABLE "platform_ai" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"preset" text NOT NULL,
	"model" text NOT NULL,
	"thinking" text DEFAULT 'off' NOT NULL,
	"key_ciphertext" text,
	"key_iv" text,
	"key_auth_tag" text,
	"key_last4" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ai_single" CHECK ("platform_ai"."id" = 1),
	CONSTRAINT "platform_ai_thinking" CHECK ("platform_ai"."thinking" in ('off', 'low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_action";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ai_thinking" text;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_action" CHECK ("admin_actions"."action" in ('plan', 'shared_mail', 'ai', 'ai_thinking'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ai_thinking" CHECK ("users"."ai_thinking" is null or "users"."ai_thinking" in ('off', 'low', 'medium', 'high'));