UPDATE "recording_tasks" AS task
SET "status_effective_at" = COALESCE(
    task."status_changed_at",
    item."occurred_at",
    item."created_at"
)
FROM "chatter_items" AS item
WHERE task."recording_id" = item."id"
  AND task."user_id" = item."user_id"
  AND task."status" = 'open'
  AND task."status_effective_at" IS NOT DISTINCT FROM COALESCE(
      task."status_changed_at",
      task."accepted_at",
      task."created_at"
  )
  AND task."status_effective_at" IS DISTINCT FROM COALESCE(
      task."status_changed_at",
      item."occurred_at",
      item."created_at"
  );
--> statement-breakpoint
UPDATE "recording_tasks" AS task
SET "due_effective_at" = COALESCE(item."occurred_at", item."created_at")
FROM "chatter_items" AS item
WHERE task."recording_id" = item."id"
  AND task."user_id" = item."user_id"
  AND task."status" = 'open'
  AND (task."due_date" IS NOT NULL OR task."due_phrase" IS NOT NULL)
  AND task."due_effective_at" IS NULL;
