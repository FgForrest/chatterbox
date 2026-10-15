ALTER TABLE "ai_usage_events" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_actor_user_id_idx" ON "ai_usage_events" USING btree ("actor_user_id") WHERE "ai_usage_events"."actor_user_id" is not null;--> statement-breakpoint
CREATE INDEX "item_processing_profile_id_idx" ON "item_processing" USING btree ("profile_id") WHERE "item_processing"."profile_id" is not null;--> statement-breakpoint
CREATE INDEX "processing_profile_revisions_created_by_idx" ON "processing_profile_revisions" USING btree ("created_by") WHERE "processing_profile_revisions"."created_by" is not null;--> statement-breakpoint
CREATE INDEX "processing_profiles_created_by_idx" ON "processing_profiles" USING btree ("created_by") WHERE "processing_profiles"."created_by" is not null;--> statement-breakpoint
CREATE INDEX "processing_profiles_updated_by_idx" ON "processing_profiles" USING btree ("updated_by") WHERE "processing_profiles"."updated_by" is not null;