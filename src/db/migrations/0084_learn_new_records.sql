ALTER TABLE "learn_review_items" DROP CONSTRAINT "learn_review_items_kind_check";--> statement-breakpoint
ALTER TABLE "learn_dismissals" ADD COLUMN "scope_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "learn_dismissals_scope_wide_idx" ON "learn_dismissals" USING btree ("user_id") WHERE "learn_dismissals"."scope_wide";--> statement-breakpoint
ALTER TABLE "learn_review_items" ADD CONSTRAINT "learn_review_items_kind_check" CHECK ("learn_review_items"."kind" in ('speaker', 'correction', 'known_fact', 'fact', 'relation_phrase', 'new_record'));