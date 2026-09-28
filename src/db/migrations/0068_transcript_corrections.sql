CREATE TABLE "transcript_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"transcript_revision" integer NOT NULL,
	"turn_index" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"heard" text NOT NULL,
	"heard_hmac" varchar(64) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"target_person_id" text NOT NULL,
	"replacement" text,
	"pre_ticked" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_corrections_replacement_check" CHECK (("transcript_corrections"."kind" = 'correct') = ("transcript_corrections"."replacement" is not null)),
	CONSTRAINT "transcript_corrections_kind_check" CHECK ("transcript_corrections"."kind" in ('correct', 'link')),
	CONSTRAINT "transcript_corrections_span_check" CHECK ("transcript_corrections"."char_start" >= 0 and "transcript_corrections"."char_start" < "transcript_corrections"."char_end")
);
--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_target_person_id_people_id_fk" FOREIGN KEY ("target_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_corrections" ADD CONSTRAINT "transcript_corrections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_corrections_transcription_id_idx" ON "transcript_corrections" USING btree ("transcription_id");--> statement-breakpoint
CREATE INDEX "transcript_corrections_user_id_idx" ON "transcript_corrections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcript_corrections_target_person_id_idx" ON "transcript_corrections" USING btree ("target_person_id");