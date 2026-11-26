ALTER TABLE "onboarding_progress" DROP CONSTRAINT IF EXISTS "onboarding_progress_category";--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_category" CHECK ("onboarding_progress"."primary_category" in ('online_retail', 'food_orders', 'beauty_wellness', 'professional_services', 'resorts_hotels', 'other'));
