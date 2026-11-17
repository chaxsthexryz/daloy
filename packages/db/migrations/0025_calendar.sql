CREATE TABLE "calendar_events" (
	"booking_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_provider";--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider" CHECK ("connections"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider" CHECK ("deliveries"."provider" in ('google_sheets', 'slack', 'outlook', 'teams', 'telegram', 'google_calendar'));