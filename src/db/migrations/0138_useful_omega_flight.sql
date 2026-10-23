CREATE TABLE "item_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"receiver_user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"invited_by_user_id" text,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"filing_folder_id" text,
	"folder_share_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"removed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "item_shares_state_check" CHECK ("item_shares"."state" in ('pending', 'accepted', 'declined', 'removed')),
	CONSTRAINT "item_shares_receiver_check" CHECK ("item_shares"."user_id" <> "item_shares"."receiver_user_id")
);
--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_receiver_user_id_users_id_fk" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_item_id_chatter_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."chatter_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_filing_folder_id_recording_folders_id_fk" FOREIGN KEY ("filing_folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_item_owner_fk" FOREIGN KEY ("item_id","user_id") REFERENCES "public"."chatter_items"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_shares_direct_unique" ON "item_shares" USING btree ("item_id","receiver_user_id") WHERE "item_shares"."folder_share_id" is null;--> statement-breakpoint
CREATE INDEX "item_shares_receiver_state_idx" ON "item_shares" USING btree ("receiver_user_id","state");--> statement-breakpoint
CREATE INDEX "item_shares_owner_item_idx" ON "item_shares" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "item_shares_filing_folder_idx" ON "item_shares" USING btree ("filing_folder_id");--> statement-breakpoint
CREATE INDEX "item_shares_folder_share_idx" ON "item_shares" USING btree ("folder_share_id");--> statement-breakpoint
CREATE INDEX "item_shares_inviter_idx" ON "item_shares" USING btree ("invited_by_user_id");