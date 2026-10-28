CREATE TABLE "agenda_points" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agenda_id" text NOT NULL,
	"parent_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"author_user_id" text,
	"discussed_at" timestamp,
	"discussed_by_user_id" text,
	"note" text,
	"note_at" timestamp,
	"summary_outcome" varchar(16),
	"origin" varchar(16) DEFAULT 'manual' NOT NULL,
	"origin_point_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_points_origin_check" CHECK ("agenda_points"."origin" in ('manual', 'carry_over', 'ai', 'live')),
	CONSTRAINT "agenda_points_outcome_check" CHECK ("agenda_points"."summary_outcome" in ('covered', 'not_covered'))
);
--> statement-breakpoint
CREATE TABLE "agenda_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agenda_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"text" text NOT NULL,
	"parent_point_id" text,
	"sources" jsonb NOT NULL,
	"origin_point_id" text,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_suggestions_kind_check" CHECK ("agenda_suggestions"."kind" in ('carry_over', 'ai')),
	CONSTRAINT "agenda_suggestions_state_check" CHECK ("agenda_suggestions"."state" in ('open', 'added', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "agenda_tasks" (
	"user_id" text NOT NULL,
	"agenda_id" text NOT NULL,
	"task_id" text NOT NULL,
	"origin" varchar(16) NOT NULL,
	"removed_at" timestamp,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	CONSTRAINT "agenda_tasks_agenda_id_task_id_pk" PRIMARY KEY("agenda_id","task_id"),
	CONSTRAINT "agenda_tasks_origin_check" CHECK ("agenda_tasks"."origin" in ('last_meeting', 'older'))
);
--> statement-breakpoint
CREATE TABLE "meeting_agendas" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"meeting_item_id" text,
	"recording_item_id" text,
	"calendar_event_id" text,
	"calendar_series_id" text,
	"planned_start" timestamp,
	"planned_end" timestamp,
	"time_set" boolean DEFAULT false NOT NULL,
	"state" varchar(16) DEFAULT 'planned' NOT NULL,
	"live_started_at" timestamp,
	"live_ended_at" timestamp,
	"absorbed_at" timestamp,
	"task_source_item_id" text,
	"outcome_unplanned" jsonb,
	"outcome_summary_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_agendas_meeting_item_id_unique" UNIQUE("meeting_item_id"),
	CONSTRAINT "meeting_agendas_recording_item_id_unique" UNIQUE("recording_item_id"),
	CONSTRAINT "meeting_agendas_state_check" CHECK ("meeting_agendas"."state" in ('planned', 'live', 'held')),
	CONSTRAINT "meeting_agendas_time_check" CHECK ((not "meeting_agendas"."time_set" or "meeting_agendas"."planned_start" is not null) and ("meeting_agendas"."planned_end" is null or "meeting_agendas"."planned_end" > "meeting_agendas"."planned_start"))
);
--> statement-breakpoint
ALTER TABLE "chatter_items" DROP CONSTRAINT "chatter_items_kind_check";--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "calendar_series_id" text;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_agenda_id_meeting_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."meeting_agendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_parent_id_agenda_points_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agenda_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_discussed_by_user_id_users_id_fk" FOREIGN KEY ("discussed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_points" ADD CONSTRAINT "agenda_points_origin_point_id_agenda_points_id_fk" FOREIGN KEY ("origin_point_id") REFERENCES "public"."agenda_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_suggestions" ADD CONSTRAINT "agenda_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_suggestions" ADD CONSTRAINT "agenda_suggestions_agenda_id_meeting_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."meeting_agendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_suggestions" ADD CONSTRAINT "agenda_suggestions_parent_point_id_agenda_points_id_fk" FOREIGN KEY ("parent_point_id") REFERENCES "public"."agenda_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_suggestions" ADD CONSTRAINT "agenda_suggestions_origin_point_id_agenda_points_id_fk" FOREIGN KEY ("origin_point_id") REFERENCES "public"."agenda_points"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_suggestions" ADD CONSTRAINT "agenda_suggestions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD CONSTRAINT "agenda_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD CONSTRAINT "agenda_tasks_agenda_id_meeting_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."meeting_agendas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_tasks" ADD CONSTRAINT "agenda_tasks_task_id_recording_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."recording_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_meeting_item_id_chatter_items_id_fk" FOREIGN KEY ("meeting_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_recording_item_id_chatter_items_id_fk" FOREIGN KEY ("recording_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_task_source_item_id_chatter_items_id_fk" FOREIGN KEY ("task_source_item_id") REFERENCES "public"."chatter_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_outcome_summary_id_ai_enhancements_id_fk" FOREIGN KEY ("outcome_summary_id") REFERENCES "public"."ai_enhancements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_points_agenda_idx" ON "agenda_points" USING btree ("agenda_id","position");--> statement-breakpoint
CREATE INDEX "agenda_points_parent_idx" ON "agenda_points" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "agenda_suggestions_agenda_idx" ON "agenda_suggestions" USING btree ("agenda_id");--> statement-breakpoint
CREATE INDEX "agenda_tasks_task_idx" ON "agenda_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_owner_start_idx" ON "meeting_agendas" USING btree ("user_id","planned_start");--> statement-breakpoint
CREATE INDEX "meeting_agendas_event_idx" ON "meeting_agendas" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_series_idx" ON "meeting_agendas" USING btree ("calendar_series_id");--> statement-breakpoint
CREATE INDEX "meeting_agendas_held_due_idx" ON "meeting_agendas" USING btree ("planned_start") WHERE "meeting_agendas"."recording_item_id" is null and "meeting_agendas"."state" <> 'held';--> statement-breakpoint
ALTER TABLE "chatter_items" ADD CONSTRAINT "chatter_items_kind_check" CHECK ("chatter_items"."kind" in ('audio', 'mail', 'meeting'));