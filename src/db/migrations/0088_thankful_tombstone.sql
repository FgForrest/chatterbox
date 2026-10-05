DROP TABLE "ai_cost_rates" CASCADE;--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "input_usd_per_million" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "output_usd_per_million" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "api_credentials" ADD COLUMN "audio_usd_per_hour" numeric(16, 6);