CREATE TYPE "public"."recording_session_status" AS ENUM('open', 'completing', 'completed', 'failed', 'aborted');--> statement-breakpoint
ALTER TYPE "public"."api_key_source" ADD VALUE 'recorder';--> statement-breakpoint
CREATE TABLE "recording_session_chunks" (
	"session_id" text NOT NULL,
	"index" integer NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_session_chunks_session_id_index_pk" PRIMARY KEY("session_id","index")
);
--> statement-breakpoint
CREATE TABLE "recording_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" "recording_session_status" DEFAULT 'open' NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notice_acknowledged_at" timestamp,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"stop_reason" varchar(64),
	"expected_chunk_count" integer,
	"recording_id" text,
	"job_id" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_session_chunks" ADD CONSTRAINT "recording_session_chunks_session_id_recording_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."recording_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_sessions_user_id_idx" ON "recording_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_sessions_status_updated_idx" ON "recording_sessions" USING btree ("status","updated_at");