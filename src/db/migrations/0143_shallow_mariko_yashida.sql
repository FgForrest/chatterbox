CREATE TABLE "storage_daily_snapshots" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"audio_bytes" bigint NOT NULL,
	"mail_bytes" bigint NOT NULL,
	"shared_audio_bytes" bigint NOT NULL,
	"shared_mail_bytes" bigint NOT NULL,
	CONSTRAINT "storage_daily_snapshots_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "task_status_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"actor_user_id" text,
	"from_status" varchar(16),
	"to_status" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_status_transitions_status_check" CHECK ("task_status_transitions"."to_status" in ('proposed', 'open', 'done', 'dropped') and ("task_status_transitions"."from_status" is null or ("task_status_transitions"."from_status" in ('proposed', 'open', 'done', 'dropped') and "task_status_transitions"."from_status" <> "task_status_transitions"."to_status")))
);
--> statement-breakpoint
ALTER TABLE "storage_daily_snapshots" ADD CONSTRAINT "storage_daily_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_status_transitions" ADD CONSTRAINT "task_status_transitions_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_status_transitions" ADD CONSTRAINT "task_status_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_daily_snapshots_day_idx" ON "storage_daily_snapshots" USING btree ("day");--> statement-breakpoint
CREATE INDEX "task_status_transitions_task_time_idx" ON "task_status_transitions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_status_transitions_actor_idx" ON "task_status_transitions" USING btree ("actor_user_id");