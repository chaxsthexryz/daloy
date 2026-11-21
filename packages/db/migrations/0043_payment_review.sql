CREATE TABLE "payment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"due_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"transfer_ref" text,
	"normalized_ref" text,
	"submitted_centavos" integer,
	"payment_id" uuid,
	"image" "bytea",
	"image_type" text,
	"image_size" integer,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_claims_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "payment_claims_status" CHECK ("payment_claims"."status" in ('open', 'clarify', 'confirmed', 'rejected')),
	CONSTRAINT "payment_claims_flags" CHECK ("payment_claims"."flags" <@ array['duplicate_reference', 'amount_mismatch', 'unreadable_upload', 'already_confirmed', 'paid_twice', 'late_payment']::text[]),
	CONSTRAINT "payment_claims_image" CHECK (("payment_claims"."image" is null) = ("payment_claims"."image_type" is null) and ("payment_claims"."image_size" is null or "payment_claims"."image_size" between 1 and 5242880)),
	CONSTRAINT "payment_claims_amount" CHECK ("payment_claims"."submitted_centavos" is null or "payment_claims"."submitted_centavos" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_dues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"test" boolean NOT NULL,
	"workflow_id" uuid,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"reference" text NOT NULL,
	"booking_id" uuid,
	"kind" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"total_centavos" integer,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"reviewer_id" uuid,
	"reply_channel" text,
	"reply_to" text,
	"reply_text" text,
	"confirmed_source" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_claim_id" uuid,
	"confirmed_payment_id" uuid,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dues_token_unique" UNIQUE("token"),
	CONSTRAINT "payment_dues_run_id_step_id_unique" UNIQUE("run_id","step_id"),
	CONSTRAINT "payment_dues_kind" CHECK ("payment_dues"."kind" in ('deposit', 'full', 'balance')),
	CONSTRAINT "payment_dues_status" CHECK ("payment_dues"."status" in ('pending', 'confirmed', 'cancelled', 'refunded')),
	CONSTRAINT "payment_dues_amount" CHECK ("payment_dues"."amount_centavos" > 0 and ("payment_dues"."total_centavos" is null or "payment_dues"."total_centavos" >= "payment_dues"."amount_centavos")),
	CONSTRAINT "payment_dues_confirmed" CHECK (("payment_dues"."status" in ('confirmed', 'refunded')) = ("payment_dues"."confirmed_source" is not null and "payment_dues"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"due_id" uuid NOT NULL,
	"event" text NOT NULL,
	"source" text NOT NULL,
	"actor_id" uuid,
	"claim_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"gcash_number" text,
	"account_name" text,
	"qr_image" "bytea",
	"qr_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_status";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "due_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_amount_centavos" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_currency" text;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_due_id_payment_dues_id_fk" FOREIGN KEY ("due_id") REFERENCES "public"."payment_dues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dues" ADD CONSTRAINT "payment_dues_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_due_id_payment_dues_id_fk" FOREIGN KEY ("due_id") REFERENCES "public"."payment_dues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_claims_open" ON "payment_claims" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "payment_claims_ref" ON "payment_claims" USING btree ("user_id","normalized_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dues_open_order" ON "payment_dues" USING btree ("user_id","test","reference","kind") WHERE "payment_dues"."status" in ('pending', 'confirmed');--> statement-breakpoint
CREATE INDEX "payment_dues_booking" ON "payment_dues" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payment_history_due" ON "payment_history" USING btree ("due_id","at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_due_id_payment_dues_id_fk" FOREIGN KEY ("due_id") REFERENCES "public"."payment_dues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status" CHECK ("payments"."status" in ('pending', 'paid', 'refunded', 'needs_review', 'expired'));