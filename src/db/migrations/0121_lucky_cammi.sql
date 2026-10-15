CREATE TABLE "task_home_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"from_item_id" text,
	"to_item_id" text,
	"from_user_id" text,
	"to_user_id" text,
	"reason" varchar(16) NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_home_moves_reason_check" CHECK ("task_home_moves"."reason" in ('deleted', 'erased', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "task_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"view" varchar(8) NOT NULL,
	"evidence_start_ms" integer,
	"evidence_segment_index" integer,
	"evidence_char_start" integer,
	"evidence_char_end" integer,
	"quote" text,
	"provenance" varchar(16),
	"content_source_id" varchar(20),
	"content_revision" integer,
	"statement_at" timestamp NOT NULL,
	"match_decision" varchar(16) NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_mentions_view_check" CHECK ("task_mentions"."view" in ('private', 'org')),
	CONSTRAINT "task_mentions_match_decision_check" CHECK ("task_mentions"."match_decision" in ('home', 'suggested', 'accepted', 'rejected', 'undone', 'kept_new')),
	CONSTRAINT "task_mentions_evidence_check" CHECK (("task_mentions"."evidence_segment_index" is null and "task_mentions"."evidence_char_start" is null and "task_mentions"."evidence_char_end" is null) or ("task_mentions"."evidence_start_ms" is null and "task_mentions"."evidence_segment_index" >= 0 and "task_mentions"."evidence_char_start" >= 0 and "task_mentions"."evidence_char_start" < "task_mentions"."evidence_char_end"))
);
--> statement-breakpoint
CREATE TABLE "task_vectors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"vector_generation" varchar(160) NOT NULL,
	"dim" integer NOT NULL,
	"vector" text NOT NULL,
	"input_hmac" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_vectors_task_generation_unique" UNIQUE("task_id","vector_generation")
);
--> statement-breakpoint
ALTER TABLE "task_update_proposals" DROP CONSTRAINT "task_update_proposals_kind_check";--> statement-breakpoint
ALTER TABLE "task_update_proposals" DROP CONSTRAINT "task_update_proposals_due_check";--> statement-breakpoint
ALTER TABLE "task_update_proposals" ALTER COLUMN "kind" SET DATA TYPE varchar(16);--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "status_effective_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "due_effective_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "assignee_effective_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD COLUMN "origin_item_id" text;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "state" varchar(32) DEFAULT 'awaiting_source_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "routed_to" jsonb;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "decided_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD COLUMN "obsolete_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_from_item_id_chatter_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_to_item_id_chatter_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_home_moves" ADD CONSTRAINT "task_home_moves_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_mentions" ADD CONSTRAINT "task_mentions_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_mentions" ADD CONSTRAINT "task_mentions_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_mentions" ADD CONSTRAINT "task_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_mentions" ADD CONSTRAINT "task_mentions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_vectors" ADD CONSTRAINT "task_vectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_vectors" ADD CONSTRAINT "task_vectors_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_home_moves_task_id_idx" ON "task_home_moves" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_home_moves_from_item_id_idx" ON "task_home_moves" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "task_home_moves_to_item_id_idx" ON "task_home_moves" USING btree ("to_item_id");--> statement-breakpoint
CREATE INDEX "task_home_moves_from_user_id_idx" ON "task_home_moves" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "task_home_moves_to_user_id_idx" ON "task_home_moves" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "task_home_moves_actor_user_id_idx" ON "task_home_moves" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "task_mentions_task_id_idx" ON "task_mentions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_mentions_item_id_idx" ON "task_mentions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "task_mentions_user_id_idx" ON "task_mentions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_mentions_item_id_view_idx" ON "task_mentions" USING btree ("item_id","view");--> statement-breakpoint
CREATE INDEX "task_vectors_task_id_idx" ON "task_vectors" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_vectors_user_id_idx" ON "task_vectors" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "recording_tasks" ADD CONSTRAINT "recording_tasks_origin_item_id_chatter_items_id_fk" FOREIGN KEY ("origin_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_tasks_origin_item_id_idx" ON "recording_tasks" USING btree ("origin_item_id");--> statement-breakpoint
CREATE INDEX "task_update_proposals_user_id_state_idx" ON "task_update_proposals" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "task_update_proposals_decided_by_user_id_idx" ON "task_update_proposals" USING btree ("decided_by_user_id");--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_state_check" CHECK ("task_update_proposals"."state" in ('awaiting_source_review', 'awaiting_share', 'awaiting_target_review', 'applied', 'rejected', 'obsolete'));--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_kind_check" CHECK ("task_update_proposals"."kind" in ('done', 'due', 'due_phrase', 'attach_merge'));--> statement-breakpoint
ALTER TABLE "task_update_proposals" ADD CONSTRAINT "task_update_proposals_due_check" CHECK ("task_update_proposals"."kind" <> 'due' or "task_update_proposals"."due_date" is not null);