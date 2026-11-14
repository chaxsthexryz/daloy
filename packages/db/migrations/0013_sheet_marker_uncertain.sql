ALTER TABLE "deliveries" ADD COLUMN "sheet_marker_uncertain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Markers written before this column existed have an unknown history, so they count as uncertain and are kept.
UPDATE "deliveries" SET "sheet_marker_uncertain" = true WHERE "sheet_meta_id" IS NOT NULL AND "sheet_meta_cleared_at" IS NULL;
