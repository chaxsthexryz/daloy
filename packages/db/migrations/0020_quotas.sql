CREATE TABLE "usage_claims" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_claims_user_id_kind_key_pk" PRIMARY KEY("user_id","kind","key")
);
--> statement-breakpoint
CREATE TABLE "usage_counts" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "usage_counts_user_id_kind_period_pk" PRIMARY KEY("user_id","kind","period")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_started_on" date;--> statement-breakpoint
ALTER TABLE "usage_claims" ADD CONSTRAINT "usage_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "usage_counts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan" CHECK ("users"."plan" in ('pilot', 'business', 'business_plus'));