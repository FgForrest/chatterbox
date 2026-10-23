DROP INDEX "recordings_user_id_start_time_idx";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "filename";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "start_time";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "summary_due_at";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "transcript_reaped_at";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "summary_reaped_at";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "unshared_at";--> statement-breakpoint
ALTER TABLE "recordings" DROP COLUMN "title_edited_at";