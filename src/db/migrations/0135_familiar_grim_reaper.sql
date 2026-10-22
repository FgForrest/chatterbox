CREATE TABLE "almanac_duplicate_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"left_person_id" text,
	"right_person_id" text,
	"left_entity_id" text,
	"right_entity_id" text,
	"dismissed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "almanac_duplicate_dismissals_pair_unique" UNIQUE NULLS NOT DISTINCT("user_id","kind","left_person_id","right_person_id","left_entity_id","right_entity_id"),
	CONSTRAINT "almanac_duplicate_dismissals_pair_check" CHECK (
            ("almanac_duplicate_dismissals"."kind" = 'person' and "almanac_duplicate_dismissals"."left_person_id" is not null and "almanac_duplicate_dismissals"."right_person_id" is not null
                and "almanac_duplicate_dismissals"."left_person_id" < "almanac_duplicate_dismissals"."right_person_id" and "almanac_duplicate_dismissals"."left_entity_id" is null and "almanac_duplicate_dismissals"."right_entity_id" is null)
            or ("almanac_duplicate_dismissals"."kind" = 'entity' and "almanac_duplicate_dismissals"."left_entity_id" is not null and "almanac_duplicate_dismissals"."right_entity_id" is not null
                and "almanac_duplicate_dismissals"."left_entity_id" < "almanac_duplicate_dismissals"."right_entity_id" and "almanac_duplicate_dismissals"."left_person_id" is null and "almanac_duplicate_dismissals"."right_person_id" is null)
        )
);
--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_left_person_id_people_id_fk" FOREIGN KEY ("left_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_right_person_id_people_id_fk" FOREIGN KEY ("right_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_left_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("left_entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_right_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("right_entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "almanac_duplicate_dismissals" ADD CONSTRAINT "almanac_duplicate_dismissals_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "almanac_duplicate_dismissals_left_person_idx" ON "almanac_duplicate_dismissals" USING btree ("left_person_id");--> statement-breakpoint
CREATE INDEX "almanac_duplicate_dismissals_right_person_idx" ON "almanac_duplicate_dismissals" USING btree ("right_person_id");--> statement-breakpoint
CREATE INDEX "almanac_duplicate_dismissals_left_entity_idx" ON "almanac_duplicate_dismissals" USING btree ("left_entity_id");--> statement-breakpoint
CREATE INDEX "almanac_duplicate_dismissals_right_entity_idx" ON "almanac_duplicate_dismissals" USING btree ("right_entity_id");