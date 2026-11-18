ALTER TABLE "paymongo_events" DROP CONSTRAINT "paymongo_events_pkey";--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD CONSTRAINT "paymongo_events_user_id_event_id_pk" PRIMARY KEY("user_id","event_id");--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD COLUMN "state" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "paymongo_events" ADD COLUMN "payload" jsonb;
