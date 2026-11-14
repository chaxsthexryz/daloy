CREATE TABLE "shared_mail_usage" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"sent" integer NOT NULL,
	CONSTRAINT "shared_mail_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shared_mail_daily_limit" integer;--> statement-breakpoint
ALTER TABLE "shared_mail_usage" ADD CONSTRAINT "shared_mail_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;