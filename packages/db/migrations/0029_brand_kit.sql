ALTER TABLE "business_profiles" ADD COLUMN "logo" bytea;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "logo_type" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_logo_type" CHECK ("business_profiles"."logo_type" in ('png', 'jpeg', 'webp'));--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_accent" CHECK ("business_profiles"."accent" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_logo_pair" CHECK (("business_profiles"."logo" is null) = ("business_profiles"."logo_type" is null));