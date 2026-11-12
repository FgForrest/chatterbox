CREATE TABLE "recorder_room_presence" (
	"user_id" text NOT NULL,
	"room_key" varchar(64) NOT NULL,
	"agenda_id" text,
	"seen_at" timestamp DEFAULT now() NOT NULL,
	"written_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recorder_room_presence_user_id_room_key_pk" PRIMARY KEY("user_id","room_key")
);
--> statement-breakpoint
ALTER TABLE "recorder_room_presence" ADD CONSTRAINT "recorder_room_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_room_presence" ADD CONSTRAINT "recorder_room_presence_agenda_id_meeting_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."meeting_agendas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recorder_room_presence_room_seen_idx" ON "recorder_room_presence" USING btree ("room_key","seen_at");--> statement-breakpoint
CREATE INDEX "recorder_room_presence_seen_idx" ON "recorder_room_presence" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "recorder_room_presence_agenda_idx" ON "recorder_room_presence" USING btree ("agenda_id");