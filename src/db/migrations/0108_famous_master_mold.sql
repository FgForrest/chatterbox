CREATE TABLE "recording_capture_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_recording_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"encrypted_key" text,
	"active_session_id" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_capture_keys_user_client_unique" UNIQUE("user_id","client_recording_id")
);
--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "capture_key_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "client_recording_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "api_key_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD COLUMN "truncated_at_chunk" integer;--> statement-breakpoint
ALTER TABLE "recording_capture_keys" ADD CONSTRAINT "recording_capture_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_capture_keys" ADD CONSTRAINT "recording_capture_keys_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_capture_keys_expires_idx" ON "recording_capture_keys" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_capture_key_id_recording_capture_keys_id_fk" FOREIGN KEY ("capture_key_id") REFERENCES "public"."recording_capture_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_sessions" ADD CONSTRAINT "recording_sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_sessions_capture_key_id_idx" ON "recording_sessions" USING btree ("capture_key_id");