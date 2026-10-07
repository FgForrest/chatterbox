CREATE TABLE "mcp_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"caller_kind" varchar(8),
	"user_id" text,
	"subject" text,
	"client_id" text,
	"tool" varchar(64),
	"outcome" varchar(16) NOT NULL,
	"target_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "mcp_access_log" ADD CONSTRAINT "mcp_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_access_log_at_idx" ON "mcp_access_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "mcp_access_log_user_at_idx" ON "mcp_access_log" USING btree ("user_id","at");