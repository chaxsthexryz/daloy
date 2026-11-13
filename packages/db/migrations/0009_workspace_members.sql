CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_role" CHECK ("invites"."role" in ('operator', 'approver', 'requester'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_role" CHECK ("workspace_members"."role" in ('owner', 'operator', 'approver', 'requester')),
	CONSTRAINT "workspace_members_owner" CHECK (("workspace_members"."role" = 'owner') = ("workspace_members"."workspace_id" = "workspace_members"."user_id"))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approver_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_by_email" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_users_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_users_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_workspace" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every account so far owns its own workspace (decision 0022).
INSERT INTO "workspace_members" ("user_id", "workspace_id", "role") SELECT "id", "id", 'owner' FROM "users";
