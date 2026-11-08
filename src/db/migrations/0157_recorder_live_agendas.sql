CREATE TABLE "agenda_event_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agenda_text_docs" (
	"user_id" text NOT NULL,
	"agenda_id" text NOT NULL,
	"field" varchar(270) NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "agenda_text_docs_agenda_id_field_pk" PRIMARY KEY("agenda_id","field")
);
--> statement-breakpoint
ALTER TABLE "agenda_points" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "agenda_event_streams" ADD CONSTRAINT "agenda_event_streams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_text_docs" ADD CONSTRAINT "agenda_text_docs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_text_docs" ADD CONSTRAINT "agenda_text_docs_agenda_id_meeting_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."meeting_agendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_text_docs" ADD CONSTRAINT "agenda_text_docs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_event_streams_user_expires_idx" ON "agenda_event_streams" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "agenda_event_streams_expires_idx" ON "agenda_event_streams" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agenda_text_docs_user_idx" ON "agenda_text_docs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agenda_text_docs_updated_by_idx" ON "agenda_text_docs" USING btree ("updated_by_user_id");--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD CONSTRAINT "agenda_tasks_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_points_updated_by_idx" ON "agenda_points" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "agenda_tasks_updated_by_idx" ON "agenda_tasks" USING btree ("updated_by_user_id");