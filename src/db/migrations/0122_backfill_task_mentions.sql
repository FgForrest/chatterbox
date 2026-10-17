UPDATE "recording_tasks" AS "task"
SET
    "origin_item_id" = COALESCE("task"."origin_item_id", "task"."recording_id"),
    "status_effective_at" = CASE
        WHEN "task"."status" <> 'proposed'
            THEN COALESCE(
                "task"."status_effective_at",
                "task"."status_changed_at",
                "task"."accepted_at",
                "task"."created_at"
            )
        ELSE "task"."status_effective_at"
    END
WHERE "task"."origin_item_id" IS NULL
   OR (
       "task"."status" <> 'proposed'
       AND "task"."status_effective_at" IS NULL
   );
--> statement-breakpoint
INSERT INTO "task_mentions" (
    "id",
    "task_id",
    "item_id",
    "user_id",
    "view",
    "evidence_start_ms",
    "evidence_segment_index",
    "evidence_char_start",
    "evidence_char_end",
    "quote",
    "provenance",
    "content_source_id",
    "content_revision",
    "statement_at",
    "match_decision",
    "created_at",
    "updated_at"
)
SELECT
    "task"."id",
    "task"."id",
    "task"."recording_id",
    "item"."user_id",
    CASE WHEN EXISTS (
        SELECT 1
        FROM "recording_folder_assignments" AS "assignment"
        INNER JOIN "recording_folders" AS "folder"
            ON "folder"."id" = "assignment"."folder_id"
        INNER JOIN "users" AS "folder_owner"
            ON "folder_owner"."id" = "folder"."user_id"
           AND "folder_owner"."role" = 'org'
        WHERE "assignment"."recording_id" = "task"."recording_id"
    ) THEN 'org' ELSE 'private' END,
    "task"."evidence_start_ms",
    "task"."evidence_segment_index",
    "task"."evidence_char_start",
    "task"."evidence_char_end",
    "task"."quote",
    "task"."evidence_provenance",
    CASE
        WHEN "item"."kind" = 'mail' AND "mail_content"."id" IS NOT NULL
            THEN 'mail'
        WHEN "item"."kind" = 'audio' AND "audio_content"."id" IS NOT NULL
            THEN "audio_content"."source"
        ELSE NULL
    END,
    CASE
        WHEN "item"."kind" = 'mail' THEN "mail_content"."revision"
        WHEN "item"."kind" = 'audio' THEN "audio_content"."revision"
        ELSE NULL
    END,
    COALESCE("item"."occurred_at", "item"."created_at"),
    'home',
    "task"."created_at",
    "task"."updated_at"
FROM "recording_tasks" AS "task"
INNER JOIN "chatter_items" AS "item"
    ON "item"."id" = "task"."recording_id"
LEFT JOIN "mail_contents" AS "mail_content"
    ON "item"."kind" = 'mail'
   AND "mail_content"."item_id" = "item"."id"
   AND "mail_content"."user_id" = "item"."user_id"
LEFT JOIN "transcriptions" AS "audio_content"
    ON "item"."kind" = 'audio'
   AND "audio_content"."recording_id" = "item"."id"
   AND "audio_content"."user_id" = "item"."user_id"
   AND "task"."source" IN ('riffado', 'plaud')
   AND "audio_content"."source" = "task"."source"
WHERE NOT EXISTS (
    SELECT 1
    FROM "task_mentions" AS "existing"
    WHERE "existing"."task_id" = "task"."id"
);
