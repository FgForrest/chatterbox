DROP INDEX "async_jobs_due_idx";--> statement-breakpoint
DROP INDEX "knowledge_vectors_user_id_idx";--> statement-breakpoint
DROP INDEX "people_user_id_idx";--> statement-breakpoint
DROP INDEX "plaud_devices_user_id_idx";--> statement-breakpoint
DROP INDEX "recording_folders_user_id_idx";--> statement-breakpoint
DROP INDEX "recordings_user_id_idx";--> statement-breakpoint
DROP INDEX "recordings_plaud_file_id_idx";--> statement-breakpoint
DROP INDEX "transcriptions_recording_id_idx";--> statement-breakpoint
DROP INDEX "webhook_deliveries_pending_idx";--> statement-breakpoint
DROP INDEX "async_jobs_completed_at_idx";--> statement-breakpoint
DROP INDEX "folder_export_materializations_pending_idx";--> statement-breakpoint
DROP INDEX "stripe_webhook_events_due_idx";--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "admin_action_log_admin_user_id_idx" ON "admin_action_log" USING btree ("admin_user_id") WHERE "admin_action_log"."admin_user_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_enhancements_user_id_idx" ON "ai_enhancements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_enhancements_produced_by_user_id_idx" ON "ai_enhancements" USING btree ("produced_by_user_id") WHERE "ai_enhancements"."produced_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_usage_events_payer_user_id_idx" ON "ai_usage_events" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "api_credentials_user_id_idx" ON "api_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "async_jobs_claim_idx" ON "async_jobs" USING btree ("kind","priority" DESC NULLS FIRST,"next_attempt_at","created_at") WHERE "async_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "async_jobs_processing_idx" ON "async_jobs" USING btree ("heartbeat_at") WHERE "async_jobs"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "async_jobs_active_subject_idx" ON "async_jobs" USING btree ("subject_id") WHERE "async_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "email_deliveries_subscriber_id_idx" ON "email_deliveries" USING btree ("subscriber_id") WHERE "email_deliveries"."subscriber_id" is not null;--> statement-breakpoint
CREATE INDEX "export_jobs_stale_storage_keys_idx" ON "export_jobs" USING btree ("created_at","id") WHERE "export_jobs"."stale_storage_keys" <> '[]'::jsonb;--> statement-breakpoint
CREATE INDEX "folder_export_directories_folder_id_idx" ON "folder_export_directories" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "folder_export_materializations_recording_id_idx" ON "folder_export_materializations" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "folder_export_materializations_placement_folder_id_idx" ON "folder_export_materializations" USING btree ("placement_folder_id");--> statement-breakpoint
CREATE INDEX "folder_export_placements_recording_id_idx" ON "folder_export_placements" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "folder_export_placements_placement_folder_id_idx" ON "folder_export_placements" USING btree ("placement_folder_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_user_id_relation_key_idx" ON "knowledge_facts" USING btree ("user_id","relation_key");--> statement-breakpoint
CREATE INDEX "learn_runs_ready_idx" ON "learn_runs" USING btree ("view","user_id","recording_id") WHERE "learn_runs"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "people_primary_email_hash_idx" ON "people" USING btree ("primary_email_hash") WHERE "people"."primary_email_hash" is not null;--> statement-breakpoint
CREATE INDEX "people_merged_into_id_idx" ON "people" USING btree ("merged_into_id") WHERE "people"."merged_into_id" is not null;--> statement-breakpoint
CREATE INDEX "people_created_by_user_id_idx" ON "people" USING btree ("created_by_user_id") WHERE "people"."created_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "plaud_connections_user_id_idx" ON "plaud_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recording_folders_created_by_user_id_idx" ON "recording_folders" USING btree ("created_by_user_id") WHERE "recording_folders"."created_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "recordings_user_id_updated_at_live_idx" ON "recordings" USING btree ("user_id","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "recordings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transcript_speakers_confirmed_by_user_id_idx" ON "transcript_speakers" USING btree ("confirmed_by_user_id") WHERE "transcript_speakers"."confirmed_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "transcriptions_produced_by_user_id_idx" ON "transcriptions" USING btree ("produced_by_user_id") WHERE "transcriptions"."produced_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at","id") WHERE "webhook_deliveries"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_settled_idx" ON "webhook_deliveries" USING btree ("updated_at") WHERE "webhook_deliveries"."status" in ('success', 'dead');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_user_id_idx" ON "webhook_deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "async_jobs_completed_at_idx" ON "async_jobs" USING btree ("completed_at") WHERE "async_jobs"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "folder_export_materializations_pending_idx" ON "folder_export_materializations" USING btree ("user_id") WHERE "folder_export_materializations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_due_idx" ON "stripe_webhook_events" USING btree ("next_attempt_at","created_at") WHERE "stripe_webhook_events"."status" in ('pending', 'processing');