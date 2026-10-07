CREATE TABLE "recording_task_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"fingerprint_hmac" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_task_rejections_unique" UNIQUE("recording_id","fingerprint_hmac")
);
--> statement-breakpoint
CREATE TABLE "recording_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"text" text NOT NULL,
	"assignee_person_id" text,
	"assignee_hint" text,
	"assignee_check" boolean DEFAULT false NOT NULL,
	"due_date" date,
	"due_phrase" text,
	"quote" text,
	"evidence_start_ms" integer,
	"source" varchar(16) NOT NULL,
	"ticked" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"accepted_at" timestamp,
	"accepted_by_user_id" text,
	"status_changed_at" timestamp,
	"status_changed_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_tasks_status_check" CHECK ("recording_tasks"."status" in ('proposed', 'open', 'done', 'dropped')),
	CONSTRAINT "recording_tasks_source_check" CHECK ("recording_tasks"."source" in ('riffado', 'plaud', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "task_update_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"due_date" date,
	"due_phrase" text,
	"quote" text,
	"evidence_start_ms" integer,
	"ticked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_update_proposals_unique" UNIQUE("task_id","recording_id","kind"),
	CONSTRAINT "task_update_proposals_kind_check" CHECK ("task_update_proposals"."kind" in ('done', 'due')),
	CONSTRAINT "task_update_proposals_due_check" CHECK ("task_update_proposals"."kind" = 'done' or "task_update_proposals"."due_date" is not null)
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "tasks_seen_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_task_rejections" ADD CONSTRAINT "recording_task_rejections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_task_rejections" ADD CONSTRAINT "recording_task_rejections_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_assignee_person_id_people_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_status_changed_by_user_id_users_id_fk" FOREIGN KEY ("status_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_task_rejections_user_id_idx" ON "recording_task_rejections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_tasks_recording_status_idx" ON "recording_tasks" USING btree ("recording_id","status");--> statement-breakpoint
CREATE INDEX "recording_tasks_assignee_person_id_idx" ON "recording_tasks" USING btree ("assignee_person_id");--> statement-breakpoint
CREATE INDEX "recording_tasks_user_status_idx" ON "recording_tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "recording_tasks_created_by_user_id_idx" ON "recording_tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "recording_tasks_accepted_by_user_id_idx" ON "recording_tasks" USING btree ("accepted_by_user_id");--> statement-breakpoint
CREATE INDEX "recording_tasks_status_changed_by_user_id_idx" ON "recording_tasks" USING btree ("status_changed_by_user_id");--> statement-breakpoint
CREATE INDEX "recording_tasks_updated_by_user_id_idx" ON "recording_tasks" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "task_update_proposals_recording_id_idx" ON "task_update_proposals" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "task_update_proposals_user_id_idx" ON "task_update_proposals" USING btree ("user_id");