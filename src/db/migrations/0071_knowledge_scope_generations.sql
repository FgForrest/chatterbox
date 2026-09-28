CREATE TABLE "knowledge_scope_generations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_scope_generations" ADD CONSTRAINT "knowledge_scope_generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;