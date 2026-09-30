ALTER TABLE "ai_enhancements" ADD COLUMN "input_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "topics_input_fingerprint" varchar(64);