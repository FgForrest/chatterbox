CREATE TABLE "task_content_vectors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"content_source_id" varchar(20) NOT NULL,
	"content_revision" integer NOT NULL,
	"vector_generation" varchar(160) NOT NULL,
	"chunk_index" integer NOT NULL,
	"dim" integer NOT NULL,
	"vector" text NOT NULL,
	"input_hmac" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_content_vectors_content_generation_chunk_unique" UNIQUE("item_id","content_source_id","content_revision","vector_generation","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "task_update_proposals" DROP CONSTRAINT "task_update_proposals_unique";--> statement-breakpoint
ALTER TABLE "task_content_vectors" ADD CONSTRAINT "task_content_vectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_content_vectors" ADD CONSTRAINT "task_content_vectors_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_content_vectors_user_id_item_id_idx" ON "task_content_vectors" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_update_proposals_pending_unique" ON "task_update_proposals" USING btree ("task_id","recording_id","kind") WHERE "task_update_proposals"."state" in ('awaiting_source_review', 'awaiting_share', 'awaiting_target_review');