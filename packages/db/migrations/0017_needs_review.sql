ALTER TYPE "public"."run_state" ADD VALUE 'needs_review' BEFORE 'succeeded';--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_outcome" CHECK ("step_runs"."outcome" in ('not_sent', 'rejected', 'throttled', 'unknown'));