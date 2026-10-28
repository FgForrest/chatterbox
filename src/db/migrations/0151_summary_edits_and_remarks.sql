CREATE TABLE "summary_remarks" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"author_user_id" text,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "edited_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "edited_by_user_id" text;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD COLUMN "remarks_applied_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_remarks" ADD CONSTRAINT "summary_remarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_remarks" ADD CONSTRAINT "summary_remarks_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_remarks" ADD CONSTRAINT "summary_remarks_item_owner_fk" FOREIGN KEY ("item_id","user_id") REFERENCES "public"."chatter_items"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "summary_remarks_owner_item_idx" ON "summary_remarks" USING btree ("user_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "summary_remarks_author_idx" ON "summary_remarks" USING btree ("author_user_id");--> statement-breakpoint
ALTER TABLE "ai_enhancements" ADD CONSTRAINT "ai_enhancements_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_enhancements_edited_by_user_id_idx" ON "ai_enhancements" USING btree ("edited_by_user_id");