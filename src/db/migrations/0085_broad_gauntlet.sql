CREATE TABLE "ai_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"payer_user_id" text NOT NULL,
	"operation" varchar(24) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"audio_seconds" numeric(16, 3),
	"cost_usd" numeric(18, 9),
	"price_source" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_recording_payer_idx" ON "ai_usage_events" USING btree ("recording_id","payer_user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_id_idx" ON "ai_usage_events" USING btree ("user_id");