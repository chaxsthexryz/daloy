CREATE TABLE "onboarding_progress" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"primary_category" text,
	"related_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"goal" text,
	"payment" text,
	"workflow_id" uuid,
	"sample" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_progress_status" CHECK ("onboarding_progress"."status" in ('in_progress', 'completed', 'dismissed')),
	CONSTRAINT "onboarding_progress_completed" CHECK ("onboarding_progress"."completed" between 0 and 3),
	CONSTRAINT "onboarding_progress_category" CHECK ("onboarding_progress"."primary_category" in ('online_retail', 'food_orders', 'beauty_wellness', 'professional_services', 'other')),
	CONSTRAINT "onboarding_progress_related" CHECK (cardinality("onboarding_progress"."related_categories") <= 3),
	CONSTRAINT "onboarding_progress_goal" CHECK ("onboarding_progress"."goal" in ('receipt_review', 'bookings', 'order_follow_up')),
	CONSTRAINT "onboarding_progress_payment" CHECK ("onboarding_progress"."payment" in ('manual_qrph', 'gcash_paymongo', 'pay_later'))
);
--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Workspaces that exist now keep their settings and are not asked to onboard (decision 0082).
INSERT INTO "onboarding_progress" ("user_id", "status") SELECT "id", 'dismissed' FROM "users" ON CONFLICT DO NOTHING;
