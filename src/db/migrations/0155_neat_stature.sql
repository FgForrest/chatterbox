DROP INDEX "accounts_provider_account_idx";--> statement-breakpoint
DELETE FROM "accounts" AS newer
USING "accounts" AS older
WHERE newer."provider_id" = older."provider_id"
  AND newer."account_id" = older."account_id"
  AND newer."user_id" = older."user_id"
  AND (older."created_at", older."id") < (newer."created_at", newer."id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider_id","account_id");