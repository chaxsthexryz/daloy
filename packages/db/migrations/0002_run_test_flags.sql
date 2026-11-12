ALTER TABLE "runs" ADD COLUMN "test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "live" boolean DEFAULT false NOT NULL;