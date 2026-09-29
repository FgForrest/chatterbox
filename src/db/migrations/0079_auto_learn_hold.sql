ALTER TABLE "recordings" ADD COLUMN "summary_due_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_learn" boolean DEFAULT false NOT NULL;