ALTER TABLE "task_update_proposals" DROP CONSTRAINT "task_update_proposals_kind_check";--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "proposed_assignee_person_id" text;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "proposed_assignee_hint" text;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "proposed_assignee_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_proposed_assignee_person_id_people_id_fk" FOREIGN KEY ("proposed_assignee_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_update_proposals_proposed_assignee_person_id_idx" ON "task_update_proposals" USING btree ("proposed_assignee_person_id");--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_kind_check" CHECK ("task_update_proposals"."kind" in ('done', 'drop', 'due', 'due_phrase', 'assignee', 'attach_merge'));