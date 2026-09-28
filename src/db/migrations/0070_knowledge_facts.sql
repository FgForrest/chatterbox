CREATE TABLE "knowledge_fact_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fact_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"recording_id" text NOT NULL,
	"transcript_revision" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"speaker_label" varchar(64),
	"depends_on_speaker" boolean DEFAULT false NOT NULL,
	"quote" text NOT NULL,
	"status" varchar(16) DEFAULT 'supported' NOT NULL,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_fact_evidence_unique" UNIQUE("fact_id","transcription_id","start_ms","end_ms"),
	CONSTRAINT "knowledge_fact_evidence_status_check" CHECK ("knowledge_fact_evidence"."status" in ('supported', 'wording_changed', 'speaker_changed')),
	CONSTRAINT "knowledge_fact_evidence_range_check" CHECK ("knowledge_fact_evidence"."start_ms" >= 0 and "knowledge_fact_evidence"."start_ms" <= "knowledge_fact_evidence"."end_ms")
);
--> statement-breakpoint
CREATE TABLE "knowledge_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject_person_id" text,
	"subject_entity_id" text,
	"relation_key" varchar(64) NOT NULL,
	"object_person_id" text,
	"object_entity_id" text,
	"object_literal" text,
	"subject_key" varchar(80) NOT NULL,
	"object_key" varchar(80) NOT NULL,
	"origin" varchar(16) NOT NULL,
	"replaced_by_fact_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_facts_unique" UNIQUE("user_id","subject_key","relation_key","object_key"),
	CONSTRAINT "knowledge_facts_one_subject_check" CHECK (num_nonnulls("knowledge_facts"."subject_person_id", "knowledge_facts"."subject_entity_id") = 1),
	CONSTRAINT "knowledge_facts_one_object_check" CHECK (num_nonnulls("knowledge_facts"."object_person_id", "knowledge_facts"."object_entity_id", "knowledge_facts"."object_literal") = 1),
	CONSTRAINT "knowledge_facts_origin_check" CHECK ("knowledge_facts"."origin" in ('recording', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_fact_id_knowledge_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."knowledge_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fact_evidence" ADD CONSTRAINT "knowledge_fact_evidence_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_subject_person_id_people_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_subject_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_object_person_id_people_id_fk" FOREIGN KEY ("object_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_object_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_replaced_by_fact_id_knowledge_facts_id_fk" FOREIGN KEY ("replaced_by_fact_id") REFERENCES "public"."knowledge_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_transcription_id_idx" ON "knowledge_fact_evidence" USING btree ("transcription_id");--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_recording_id_idx" ON "knowledge_fact_evidence" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "knowledge_fact_evidence_user_id_idx" ON "knowledge_fact_evidence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_subject_person_id_idx" ON "knowledge_facts" USING btree ("subject_person_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_subject_entity_id_idx" ON "knowledge_facts" USING btree ("subject_entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_object_person_id_idx" ON "knowledge_facts" USING btree ("object_person_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_object_entity_id_idx" ON "knowledge_facts" USING btree ("object_entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_facts_replaced_by_fact_id_idx" ON "knowledge_facts" USING btree ("replaced_by_fact_id");