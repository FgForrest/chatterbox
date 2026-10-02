CREATE TABLE "transcript_correction_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope_user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"transcript_revision" integer NOT NULL,
	"learn_run_id" text,
	"view" varchar(16) NOT NULL,
	"actor_user_id" text,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"path" varchar(16),
	"provider" varchar(100),
	"model" varchar(100),
	"job_id" text,
	"stats" jsonb,
	"error_code" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_correction_passes_status_check" CHECK ("transcript_correction_passes"."status" in ('queued', 'running', 'finished', 'failed', 'superseded', 'cancelled')),
	CONSTRAINT "transcript_correction_passes_view_check" CHECK ("transcript_correction_passes"."view" in ('private', 'org'))
);
--> statement-breakpoint
ALTER TABLE "transcript_corrections" DROP CONSTRAINT "transcript_corrections_one_target_check";--> statement-breakpoint
ALTER TABLE "transcript_corrections" DROP CONSTRAINT "transcript_corrections_replacement_check";--> statement-breakpoint
ALTER TABLE "transcript_corrections" DROP CONSTRAINT "transcript_corrections_kind_check";--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD COLUMN "pass_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "correct_after_learn" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_scope_user_id_users_id_fk" FOREIGN KEY ("scope_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_learn_run_id_learn_runs_id_fk" FOREIGN KEY ("learn_run_id") REFERENCES "public"."learn_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_correction_passes" ADD CONSTRAINT "transcript_correction_passes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_recording_id_idx" ON "transcript_correction_passes" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_transcription_id_idx" ON "transcript_correction_passes" USING btree ("transcription_id");--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_user_id_idx" ON "transcript_correction_passes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_scope_user_id_idx" ON "transcript_correction_passes" USING btree ("scope_user_id");--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_actor_user_id_idx" ON "transcript_correction_passes" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "transcript_correction_passes_learn_run_id_idx" ON "transcript_correction_passes" USING btree ("learn_run_id");--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_pass_id_transcript_correction_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."transcript_correction_passes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_corrections_pass_id_idx" ON "transcript_corrections" USING btree ("pass_id");--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_one_target_check" CHECK (num_nonnulls("transcript_corrections"."target_person_id", "transcript_corrections"."target_entity_id") = 1 or ("transcript_corrections"."kind" = 'fix' and "transcript_corrections"."target_person_id" is null and "transcript_corrections"."target_entity_id" is null));--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_replacement_check" CHECK (("transcript_corrections"."kind" in ('correct', 'fix')) = ("transcript_corrections"."replacement" is not null));--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_kind_check" CHECK ("transcript_corrections"."kind" in ('correct', 'link', 'fix'));