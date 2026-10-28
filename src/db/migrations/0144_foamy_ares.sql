ALTER TABLE "ai_usage_events" DROP CONSTRAINT "ai_usage_events_recording_id_chatter_items_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ALTER COLUMN "recording_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "item_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "outcome" varchar(16) DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_recording_id_chatter_items_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;