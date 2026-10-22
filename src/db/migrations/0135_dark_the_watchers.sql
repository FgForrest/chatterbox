CREATE TABLE "task_followers" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_followers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_unfollows" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_unfollows_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "recording_tasks" DROP CONSTRAINT "recording_tasks_source_check";--> statement-breakpoint
ALTER TABLE "recording_tasks" ALTER COLUMN "recording_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "note_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "note_updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "task_followers" ADD CONSTRAINT "task_followers_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_followers" ADD CONSTRAINT "task_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_unfollows" ADD CONSTRAINT "task_unfollows_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_unfollows" ADD CONSTRAINT "task_unfollows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_followers_user_id_idx" ON "task_followers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_unfollows_user_id_idx" ON "task_unfollows" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_note_updated_by_user_id_users_id_fk" FOREIGN KEY ("note_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_tasks_note_updated_by_idx" ON "recording_tasks" USING btree ("note_updated_by_user_id");--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_personal_item_check" CHECK (("recording_tasks"."source" = 'personal') = ("recording_tasks"."recording_id" is null) and ("recording_tasks"."source" <> 'personal' or ("recording_tasks"."assignee_person_id" is null and "recording_tasks"."status" <> 'proposed')));--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_source_check" CHECK ("recording_tasks"."source" in ('riffado', 'plaud', 'manual', 'personal'));