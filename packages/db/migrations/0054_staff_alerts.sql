ALTER TABLE "users" ADD COLUMN "staff_alert_psid" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_staff_alert_psid" CHECK ("users"."staff_alert_psid" is null or length("users"."staff_alert_psid") <= 64);
