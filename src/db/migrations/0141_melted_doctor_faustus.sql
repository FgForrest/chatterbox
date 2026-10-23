CREATE TABLE "almanac_share_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"target_id" text NOT NULL,
	"record_person_id" text,
	"record_entity_id" text,
	"added" boolean NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"removed_at" timestamp,
	"removed_by_user_id" text,
	"kept_reason" varchar(32),
	CONSTRAINT "almanac_share_changes_event_target_unique" UNIQUE("event_id","kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "almanac_share_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text,
	"shared_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by_user_id" text,
	"undone_at" timestamp,
	"undone_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" DROP CONSTRAINT "almanac_duplicate_dismissals_pair_unique";--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" DROP CONSTRAINT "almanac_duplicate_dismissals_pair_check";--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ALTER COLUMN "kind" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD COLUMN "problem_key" varchar(64);--> statement-breakpoint
ALTER TABLE "almanac_share_changes" ADD CONSTRAINT "almanac_share_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_changes" ADD CONSTRAINT "almanac_share_changes_event_id_almanac_share_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."almanac_share_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_changes" ADD CONSTRAINT "almanac_share_changes_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_events" ADD CONSTRAINT "almanac_share_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_events" ADD CONSTRAINT "almanac_share_events_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_events" ADD CONSTRAINT "almanac_share_events_shared_by_user_id_users_id_fk" FOREIGN KEY ("shared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_events" ADD CONSTRAINT "almanac_share_events_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_share_events" ADD CONSTRAINT "almanac_share_events_undone_by_user_id_users_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "almanac_share_changes_target_idx" ON "almanac_share_changes" USING btree ("user_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "almanac_share_changes_event_scope_idx" ON "almanac_share_changes" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "almanac_share_events_scope_time_idx" ON "almanac_share_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "almanac_dismissals_scope_idx" ON "almanac_duplicate_dismissals" USING btree ("user_id","kind");--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_pair_unique" UNIQUE NULLS NOT DISTINCT("user_id","kind","left_person_id","right_person_id","left_entity_id","right_entity_id","problem_key");--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_pair_check" CHECK (
            ("almanac_duplicate_dismissals"."kind" = 'person' and "almanac_duplicate_dismissals"."left_person_id" is not null and "almanac_duplicate_dismissals"."right_person_id" is not null
                and "almanac_duplicate_dismissals"."left_person_id" collate "C" < "almanac_duplicate_dismissals"."right_person_id" collate "C" and "almanac_duplicate_dismissals"."left_entity_id" is null and "almanac_duplicate_dismissals"."right_entity_id" is null)
            or ("almanac_duplicate_dismissals"."kind" = 'entity' and "almanac_duplicate_dismissals"."left_entity_id" is not null and "almanac_duplicate_dismissals"."right_entity_id" is not null
                and "almanac_duplicate_dismissals"."left_entity_id" collate "C" < "almanac_duplicate_dismissals"."right_entity_id" collate "C" and "almanac_duplicate_dismissals"."left_person_id" is null and "almanac_duplicate_dismissals"."right_person_id" is null)
            or ("almanac_duplicate_dismissals"."kind" in ('fact_conflict', 'correction_conflict', 'thin') and "almanac_duplicate_dismissals"."problem_key" is not null
                and num_nonnulls("almanac_duplicate_dismissals"."left_person_id", "almanac_duplicate_dismissals"."right_person_id", "almanac_duplicate_dismissals"."left_entity_id", "almanac_duplicate_dismissals"."right_entity_id") = 0)
        );