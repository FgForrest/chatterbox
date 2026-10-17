CREATE TABLE "folder_default_profiles" (
	"folder_id" text NOT NULL,
	"channel" varchar(16) NOT NULL,
	"profile_id" text,
	CONSTRAINT "folder_default_profiles_folder_id_channel_pk" PRIMARY KEY("folder_id","channel"),
	CONSTRAINT "folder_default_profiles_channel_check" CHECK ("folder_default_profiles"."channel" in ('audio', 'mail'))
);
--> statement-breakpoint
CREATE TABLE "processing_profile_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"settings" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"scope" varchar(16) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"current_revision_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "processing_profiles_scope_check" CHECK ("processing_profiles"."scope" in ('personal', 'organization')),
	CONSTRAINT "processing_profiles_channel_check" CHECK ("processing_profiles"."channel" in ('audio', 'mail'))
);
--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "profile_revision_id" text;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "builtin_prompts_version" varchar(32);--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "output_language" varchar(16);--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "output_format_locale" varchar(16);--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "payer_user_id" text;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD COLUMN "payer_user_id" text;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD COLUMN "profile_revision_id" text;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD COLUMN "builtin_prompts_version" varchar(32);--> statement-breakpoint
ALTER TABLE "learn_runs" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "profile_revision_id" text;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "builtin_prompts_version" varchar(32);--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "payer_user_id" text;--> statement-breakpoint
ALTER TABLE "folder_default_profiles" ADD CONSTRAINT "folder_default_profiles_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_default_profiles" ADD CONSTRAINT "folder_default_profiles_profile_id_processing_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."processing_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_profile_revisions" ADD CONSTRAINT "processing_profile_revisions_profile_id_processing_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."processing_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_profile_revisions" ADD CONSTRAINT "processing_profile_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_profiles" ADD CONSTRAINT "processing_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_profiles" ADD CONSTRAINT "processing_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_profiles" ADD CONSTRAINT "processing_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_default_profiles_profile_id_idx" ON "folder_default_profiles" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "processing_profile_revisions_profile_id_idx" ON "processing_profile_revisions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "processing_profiles_owner_user_id_idx" ON "processing_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_profiles_owner_channel_default_unique" ON "processing_profiles" USING btree ("owner_user_id","channel") WHERE "processing_profiles"."is_default" and "processing_profiles"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_processing" ADD CONSTRAINT "item_processing_profile_id_processing_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."processing_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learn_runs" ADD CONSTRAINT "learn_runs_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;