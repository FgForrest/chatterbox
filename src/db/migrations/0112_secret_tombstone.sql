CREATE TABLE "item_processing" (
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"view" varchar(8) NOT NULL,
	"profile_id" text,
	"profile_revision_id" text,
	"phases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_generation" integer DEFAULT 0 NOT NULL,
	"processed_generation" integer DEFAULT 0 NOT NULL,
	"waiting_since" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "item_processing_item_id_view_pk" PRIMARY KEY("item_id","view"),
	CONSTRAINT "item_processing_view_check" CHECK ("item_processing"."view" in ('private', 'org'))
);
--> statement-breakpoint
ALTER TABLE "item_processing" ADD CONSTRAINT "item_processing_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_processing" ADD CONSTRAINT "item_processing_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_processing_user_id_idx" ON "item_processing" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "item_processing_stalled_idx" ON "item_processing" USING btree ("updated_at") WHERE "item_processing"."processed_generation" < "item_processing"."requested_generation";