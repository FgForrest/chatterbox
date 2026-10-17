ALTER TABLE "mail_pending_shares" ADD COLUMN "confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" DROP COLUMN "confirmed_at";