ALTER TABLE "meeting_agendas" ADD COLUMN "calendar_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD COLUMN "calendar_refreshed_at" timestamp;