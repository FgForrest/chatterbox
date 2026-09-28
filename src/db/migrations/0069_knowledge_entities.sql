CREATE TABLE "knowledge_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"person_id" text,
	"entity_id" text,
	"kind" varchar(8) NOT NULL,
	"text" text NOT NULL,
	"text_hmac" varchar(64) NOT NULL,
	"language" varchar(16),
	"provider" varchar(64),
	"correction_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_aliases_unique" UNIQUE NULLS NOT DISTINCT("user_id","person_id","entity_id","kind","text_hmac","correction_id"),
	CONSTRAINT "knowledge_aliases_one_target_check" CHECK (num_nonnulls("knowledge_aliases"."person_id", "knowledge_aliases"."entity_id") = 1),
	CONSTRAINT "knowledge_aliases_kind_check" CHECK ("knowledge_aliases"."kind" in ('alias', 'heard_as')),
	CONSTRAINT "knowledge_aliases_heard_as_check" CHECK (("knowledge_aliases"."kind" = 'heard_as') = ("knowledge_aliases"."correction_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type_key" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"name_hmac" varchar(64) NOT NULL,
	"description" text,
	"merged_into_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entity_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"user_id" text NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entity_notes_entity_id_user_id_unique" UNIQUE("entity_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "transcript_corrections" ALTER COLUMN "target_person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD COLUMN "target_entity_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_correction_id_transcript_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."transcript_corrections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entity_notes" ADD CONSTRAINT "knowledge_entity_notes_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entity_notes" ADD CONSTRAINT "knowledge_entity_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_aliases_person_id_idx" ON "knowledge_aliases" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "knowledge_aliases_entity_id_idx" ON "knowledge_aliases" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_aliases_correction_id_idx" ON "knowledge_aliases" USING btree ("correction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entities_owner_type_name_unique" ON "knowledge_entities" USING btree ("user_id","type_key","name_hmac") WHERE "knowledge_entities"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "knowledge_entities_merged_into_id_idx" ON "knowledge_entities" USING btree ("merged_into_id");--> statement-breakpoint
CREATE INDEX "knowledge_entities_user_id_idx" ON "knowledge_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_entity_notes_user_id_idx" ON "knowledge_entity_notes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_target_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_corrections_target_entity_id_idx" ON "transcript_corrections" USING btree ("target_entity_id");--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_one_target_check" CHECK (num_nonnulls("transcript_corrections"."target_person_id", "transcript_corrections"."target_entity_id") = 1);