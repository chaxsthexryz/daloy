ALTER TABLE "bookings" DROP CONSTRAINT "bookings_status";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status" CHECK ("bookings"."status" in ('active', 'cancelled', 'no_show'));
