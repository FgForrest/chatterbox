CREATE TABLE "folder_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"receiver_user_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"invited_by_user_id" text,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	"removed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "folder_shares_folder_receiver_unique" UNIQUE("folder_id","receiver_user_id"),
	CONSTRAINT "folder_shares_id_receiver_unique" UNIQUE("id","receiver_user_id"),
	CONSTRAINT "folder_shares_state_check" CHECK ("folder_shares"."state" in ('pending', 'accepted', 'declined', 'removed')),
	CONSTRAINT "folder_shares_receiver_check" CHECK ("folder_shares"."user_id" <> "folder_shares"."receiver_user_id")
);
--> statement-breakpoint
CREATE TABLE "received_folder_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"share_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "received_folder_attachments_share_id_unique" UNIQUE("share_id")
);
--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_receiver_user_id_users_id_fk" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_folder_attachments" ADD CONSTRAINT "received_folder_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_folder_attachments" ADD CONSTRAINT "received_folder_attachments_share_id_folder_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."folder_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_folder_attachments" ADD CONSTRAINT "received_folder_attachments_parent_id_recording_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."recording_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_folder_attachments" ADD CONSTRAINT "received_folder_attachments_receiver_fk" FOREIGN KEY ("share_id","user_id") REFERENCES "public"."folder_shares"("id","receiver_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_shares_receiver_state_idx" ON "folder_shares" USING btree ("receiver_user_id","state");--> statement-breakpoint
CREATE INDEX "folder_shares_owner_folder_idx" ON "folder_shares" USING btree ("user_id","folder_id");--> statement-breakpoint
CREATE INDEX "folder_shares_inviter_idx" ON "folder_shares" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "received_folder_attachments_user_parent_idx" ON "received_folder_attachments" USING btree ("user_id","parent_id");--> statement-breakpoint
CREATE INDEX "received_folder_attachments_parent_idx" ON "received_folder_attachments" USING btree ("parent_id");