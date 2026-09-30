CREATE TABLE "knowledge_vector_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"active_generation" varchar(160),
	"embedded_at" bigint,
	"vector_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_vectors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" text,
	"fact_id" text,
	"vector_generation" varchar(160) NOT NULL,
	"dim" integer NOT NULL,
	"vector" text NOT NULL,
	"input_hmac" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_vectors_item_unique" UNIQUE NULLS NOT DISTINCT("entity_id","fact_id","vector_generation"),
	CONSTRAINT "knowledge_vectors_one_item_check" CHECK (num_nonnulls("knowledge_vectors"."entity_id", "knowledge_vectors"."fact_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "knowledge_vector_state" ADD CONSTRAINT "knowledge_vector_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_vectors" ADD CONSTRAINT "knowledge_vectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_vectors" ADD CONSTRAINT "knowledge_vectors_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_vectors" ADD CONSTRAINT "knowledge_vectors_fact_id_knowledge_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."knowledge_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_vectors_user_id_idx" ON "knowledge_vectors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_vectors_fact_id_idx" ON "knowledge_vectors" USING btree ("fact_id");