CREATE TABLE "learn_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"fingerprint_hmac" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "learn_dismissals_unique" UNIQUE("user_id","recording_id","fingerprint_hmac")
);
--> statement-breakpoint
CREATE TABLE "learn_review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"fingerprint_hmac" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"pre_ticked" boolean DEFAULT false NOT NULL,
	"decision" varchar(16),
	"version" integer DEFAULT 0 NOT NULL,
	"depends_on_label" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "learn_review_items_kind_check" CHECK ("learn_review_items"."kind" in ('speaker', 'correction', 'known_fact', 'fact', 'relation_phrase'))
);
--> statement-breakpoint
CREATE TABLE "learn_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope_user_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"view" varchar(16) NOT NULL,
	"actor_user_id" text,
	"trigger" varchar(16) NOT NULL,
	"transcript_revision" integer NOT NULL,
	"vocabulary_version" integer NOT NULL,
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
	CONSTRAINT "learn_runs_status_check" CHECK ("learn_runs"."status" in ('queued', 'running', 'ready', 'finished', 'failed', 'superseded', 'cancelled')),
	CONSTRAINT "learn_runs_view_check" CHECK ("learn_runs"."view" in ('private', 'org'))
);
--> statement-breakpoint
ALTER TABLE "learn_dismissals" ADD CONSTRAINT "learn_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_dismissals" ADD CONSTRAINT "learn_dismissals_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_review_items" ADD CONSTRAINT "learn_review_items_run_id_learn_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."learn_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_review_items" ADD CONSTRAINT "learn_review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_scope_user_id_users_id_fk" FOREIGN KEY ("scope_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learn_dismissals_recording_id_idx" ON "learn_dismissals" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "learn_review_items_run_id_idx" ON "learn_review_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "learn_review_items_user_id_idx" ON "learn_review_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "learn_runs_recording_id_idx" ON "learn_runs" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "learn_runs_transcription_id_idx" ON "learn_runs" USING btree ("transcription_id");--> statement-breakpoint
CREATE INDEX "learn_runs_user_id_idx" ON "learn_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "learn_runs_scope_user_id_idx" ON "learn_runs" USING btree ("scope_user_id");--> statement-breakpoint
CREATE INDEX "learn_runs_actor_user_id_idx" ON "learn_runs" USING btree ("actor_user_id");