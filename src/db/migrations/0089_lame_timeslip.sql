CREATE TABLE "filesystem_export_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"export_configuration_id" text NOT NULL,
	"logical_path" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "filesystem_export_nodes_path_unique" UNIQUE("export_configuration_id","logical_path")
);
--> statement-breakpoint
ALTER TABLE "filesystem_export_settings" ADD COLUMN "nodes_adopted_at" timestamp;--> statement-breakpoint
ALTER TABLE "filesystem_export_nodes" ADD CONSTRAINT "filesystem_export_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_export_nodes" ADD CONSTRAINT "filesystem_export_nodes_export_configuration_id_folder_export_configurations_id_fk" FOREIGN KEY ("export_configuration_id") REFERENCES "public"."folder_export_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filesystem_export_nodes_user_id_idx" ON "filesystem_export_nodes" USING btree ("user_id");