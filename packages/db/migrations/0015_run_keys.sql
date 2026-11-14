CREATE TABLE "run_keys" (
	"workflow_id" uuid NOT NULL,
	"test" boolean NOT NULL,
	"key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_keys_workflow_id_test_key_pk" PRIMARY KEY("workflow_id","test","key")
);
--> statement-breakpoint
ALTER TABLE "run_keys" ADD CONSTRAINT "run_keys_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_keys" ADD CONSTRAINT "run_keys_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;