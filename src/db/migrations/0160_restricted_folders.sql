CREATE TABLE "restricted_folder_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"notice_read_at" timestamp,
	CONSTRAINT "restricted_folder_access_requests_state_check" CHECK ("restricted_folder_access_requests"."state" in ('pending', 'approved', 'declined', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "restricted_folder_members" (
	"folder_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "restricted_folder_members_folder_id_user_id_pk" PRIMARY KEY("folder_id","user_id"),
	CONSTRAINT "restricted_folder_members_role_check" CHECK ("restricted_folder_members"."role" in ('manager', 'member'))
);
--> statement-breakpoint
ALTER TABLE "folder_export_materializations" DROP CONSTRAINT "folder_export_materializations_recording_id_chatter_items_id_fk";
--> statement-breakpoint
ALTER TABLE "folder_export_materializations" DROP CONSTRAINT "folder_export_materializations_placement_folder_id_recording_folders_id_fk";
--> statement-breakpoint
ALTER TABLE "folder_export_materializations" ADD COLUMN "revocation_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD COLUMN "withheld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_folder_assignments" ADD COLUMN "released_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD COLUMN "restricted_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_folders" ADD COLUMN "restricting_at" timestamp;--> statement-breakpoint
ALTER TABLE "restricted_folder_access_requests" ADD CONSTRAINT "restricted_folder_access_requests_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_folder_access_requests" ADD CONSTRAINT "restricted_folder_access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_folder_access_requests" ADD CONSTRAINT "restricted_folder_access_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_folder_members" ADD CONSTRAINT "restricted_folder_members_folder_id_recording_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."recording_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_folder_members" ADD CONSTRAINT "restricted_folder_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_folder_members" ADD CONSTRAINT "restricted_folder_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restricted_folder_access_requests_pending_unique" ON "restricted_folder_access_requests" USING btree ("folder_id","user_id") WHERE "restricted_folder_access_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "restricted_folder_access_requests_pending_folder_idx" ON "restricted_folder_access_requests" USING btree ("folder_id","created_at") WHERE "restricted_folder_access_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "restricted_folder_access_requests_user_idx" ON "restricted_folder_access_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "restricted_folder_members_user_idx" ON "restricted_folder_members" USING btree ("user_id");