CREATE TABLE "transcript_speaker_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transcription_id" text NOT NULL,
	"label" varchar(64) NOT NULL,
	"person_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_speaker_rejections_pair_unique" UNIQUE("transcription_id","label","person_id")
);
--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD COLUMN "marked_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD COLUMN "confirmed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "transcript_speaker_rejections" ADD CONSTRAINT "transcript_speaker_rejections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speaker_rejections" ADD CONSTRAINT "transcript_speaker_rejections_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_speaker_rejections" ADD CONSTRAINT "transcript_speaker_rejections_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_speaker_rejections_person_id_idx" ON "transcript_speaker_rejections" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "transcript_speaker_rejections_user_id_idx" ON "transcript_speaker_rejections" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "transcript_speakers" ADD CONSTRAINT "transcript_speakers_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;