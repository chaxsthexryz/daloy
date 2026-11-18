ALTER TABLE "calendar_events" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "calendar_id" text;--> statement-breakpoint
ALTER TABLE "email_sources" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing events: bind each to the calendar its last delivered sync wrote to (security review M11).
UPDATE "calendar_events" ce SET "account" = d.pinned_account, "calendar_id" = d.pinned_destination->>'calendarId'
FROM (
  SELECT DISTINCT ON (payload->>'bookingId') payload->>'bookingId' AS booking_id, pinned_account, pinned_destination
  FROM "deliveries"
  WHERE provider = 'google_calendar' AND state = 'delivered' AND pinned_account <> '' AND pinned_destination ? 'calendarId'
  ORDER BY payload->>'bookingId', updated_at DESC
) d
WHERE ce.booking_id::text = d.booking_id;
