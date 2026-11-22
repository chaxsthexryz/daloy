ALTER TABLE "paymongo_events" DROP CONSTRAINT IF EXISTS "paymongo_events_pkey";--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paymongo_events_user_id_event_id_pk') THEN ALTER TABLE "paymongo_events" ADD CONSTRAINT "paymongo_events_user_id_event_id_pk" PRIMARY KEY("user_id","event_id"); END IF; END $$;--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD COLUMN IF NOT EXISTS "payload" jsonb;
