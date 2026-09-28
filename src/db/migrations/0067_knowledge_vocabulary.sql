CREATE TABLE "knowledge_entity_types" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"key" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"label_hmac" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"adopted_as_key" varchar(64),
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entity_types_owner_key_unique" UNIQUE NULLS NOT DISTINCT("user_id","key"),
	CONSTRAINT "knowledge_entity_types_owner_label_unique" UNIQUE NULLS NOT DISTINCT("user_id","label_hmac")
);
--> statement-breakpoint
CREATE TABLE "knowledge_relation_types" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"key" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"label_hmac" varchar(64) NOT NULL,
	"subject_types" jsonb NOT NULL,
	"object_types" jsonb NOT NULL,
	"object_kind" varchar(16) NOT NULL,
	"cardinality" varchar(8) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"adopted_as_key" varchar(64),
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_relation_types_owner_key_unique" UNIQUE NULLS NOT DISTINCT("user_id","key"),
	CONSTRAINT "knowledge_relation_types_owner_label_unique" UNIQUE NULLS NOT DISTINCT("user_id","label_hmac")
);
--> statement-breakpoint
CREATE TABLE "knowledge_vocabulary_proposal_votes" (
	"proposal_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_vocabulary_proposal_votes_proposal_id_user_id_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_vocabulary_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"phrase" text NOT NULL,
	"phrase_hmac" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"adopted_as_key" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_vocabulary_proposals_phrase_unique" UNIQUE("phrase_hmac")
);
--> statement-breakpoint
CREATE TABLE "knowledge_vocabulary_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_entity_types" ADD CONSTRAINT "knowledge_entity_types_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entity_types" ADD CONSTRAINT "knowledge_entity_types_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relation_types" ADD CONSTRAINT "knowledge_relation_types_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relation_types" ADD CONSTRAINT "knowledge_relation_types_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_vocabulary_proposal_votes" ADD CONSTRAINT "knowledge_vocabulary_proposal_votes_proposal_id_knowledge_vocabulary_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."knowledge_vocabulary_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_vocabulary_proposal_votes" ADD CONSTRAINT "knowledge_vocabulary_proposal_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_vocabulary_proposal_votes_user_id_idx" ON "knowledge_vocabulary_proposal_votes" USING btree ("user_id");