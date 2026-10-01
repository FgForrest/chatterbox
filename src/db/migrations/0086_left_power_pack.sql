CREATE TABLE "ai_cost_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"input_usd_per_million" numeric(16, 6),
	"output_usd_per_million" numeric(16, 6),
	"audio_usd_per_hour" numeric(16, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cost_rates_user_provider_model_unique" UNIQUE("user_id","provider","model")
);
--> statement-breakpoint
ALTER TABLE "ai_cost_rates" ADD CONSTRAINT "ai_cost_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;