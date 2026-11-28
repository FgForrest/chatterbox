CREATE TABLE "recorder_offline_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "recording_capture_keys" ADD COLUMN "offline_kid" text;--> statement-breakpoint
ALTER TABLE "recording_capture_keys" ADD COLUMN "ephemeral_public_key" text;--> statement-breakpoint
ALTER TABLE "recording_capture_keys" ADD COLUMN "offline_salt" text;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "live_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "live_room_key" text;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "lease_revision" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "lease_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recorder_offline_keys" ADD CONSTRAINT "recorder_offline_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recorder_offline_keys_active_user_unique" ON "recorder_offline_keys" USING btree ("user_id") WHERE "recorder_offline_keys"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "recorder_offline_keys_user_idx" ON "recorder_offline_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_sessions_live_room_idx" ON "recording_sessions" USING btree ("live_room_key","live_until","user_id") WHERE "recording_sessions"."status" = 'open' and "recording_sessions"."lease_ended_at" is null and "recording_sessions"."live_room_key" is not null;