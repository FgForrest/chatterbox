-- Preserve the pre-pipeline cutover as already handled. A later content
-- revision no longer matches these fingerprints and enters the new workflow.
INSERT INTO "item_processing" (
    "item_id",
    "user_id",
    "view",
    "profile_id",
    "profile_revision_id",
    "phases",
    "requested_generation",
    "processed_generation",
    "created_at",
    "updated_at"
)
SELECT
    "item"."id",
    "item"."user_id",
    'private',
    NULL,
    NULL,
    jsonb_build_object(
        'categorize',
        jsonb_build_object(
            'state', CASE WHEN EXISTS (
                SELECT 1
                FROM "recording_folder_assignments" AS "placement"
                JOIN "recording_folders" AS "folder"
                  ON "folder"."id" = "placement"."folder_id"
                WHERE "placement"."recording_id" = "item"."id"
                  AND "placement"."user_id" = "item"."user_id"
                  AND "folder"."parent_id" IS NOT NULL
            ) THEN 'done' ELSE 'skipped' END,
            'reason', 'legacy',
            'generation', 0,
            'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
    ) || CASE WHEN "content"."id" IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object(
            'learn',
            jsonb_build_object(
                'state', 'done',
                'reason', 'legacy',
                'generation', 0,
                'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'inputs', jsonb_build_object(
                    'contentId', "content"."id",
                    'contentSourceId', 'riffado',
                    'contentRevision', "content"."revision"
                )
            ),
            'summary',
            jsonb_build_object(
                'state', 'done',
                'reason', 'legacy',
                'generation', 0,
                'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'inputs', jsonb_build_object(
                    'contentId', "content"."id",
                    'contentSourceId', 'riffado',
                    'contentRevision', "content"."revision"
                ),
                'steps', jsonb_build_object(
                    'title', jsonb_build_object(
                        'contentId', "content"."id",
                        'contentRevision', "content"."revision",
                        'generation', 0
                    ),
                    'topics', jsonb_build_object(
                        'contentId', "content"."id",
                        'contentRevision', "content"."revision",
                        'generation', 0
                    ),
                    'summary', jsonb_build_object(
                        'contentId', "content"."id",
                        'contentRevision', "content"."revision",
                        'generation', 0
                    )
                )
            )
        )
    END,
    0,
    0,
    now(),
    now()
FROM "chatter_items" AS "item"
LEFT JOIN LATERAL (
    SELECT "transcription"."id", "transcription"."revision"
    FROM "transcriptions" AS "transcription"
    WHERE "transcription"."recording_id" = "item"."id"
      AND "transcription"."user_id" = "item"."user_id"
      AND "transcription"."source" = 'riffado'
    ORDER BY "transcription"."created_at" DESC, "transcription"."id" DESC
    LIMIT 1
) AS "content" ON true
WHERE "item"."kind" = 'audio'
  AND "item"."deleted_at" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "item_processing" AS "existing"
      WHERE "existing"."item_id" = "item"."id"
        AND "existing"."view" = 'private'
  );
--> statement-breakpoint
INSERT INTO "item_processing" (
    "item_id",
    "user_id",
    "view",
    "profile_id",
    "profile_revision_id",
    "phases",
    "requested_generation",
    "processed_generation",
    "created_at",
    "updated_at"
)
SELECT
    "item"."id",
    "item"."user_id",
    'private',
    NULL,
    NULL,
    jsonb_build_object(
        'categorize',
        jsonb_build_object(
            'state', CASE WHEN EXISTS (
                SELECT 1
                FROM "recording_folder_assignments" AS "placement"
                JOIN "recording_folders" AS "folder"
                  ON "folder"."id" = "placement"."folder_id"
                WHERE "placement"."recording_id" = "item"."id"
                  AND "placement"."user_id" = "item"."user_id"
                  AND "folder"."parent_id" IS NOT NULL
            ) THEN 'done' ELSE 'skipped' END,
            'reason', 'legacy',
            'generation', 0,
            'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
    ) || CASE WHEN "content"."id" IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object(
            'learn',
            jsonb_build_object(
                'state', 'done',
                'reason', 'legacy',
                'generation', 0,
                'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'inputs', jsonb_build_object(
                    'contentId', "content"."id",
                    'contentSourceId', 'mail',
                    'contentRevision', "content"."revision"
                )
            ),
            'summary',
            jsonb_build_object(
                'state', 'done',
                'reason', 'legacy',
                'generation', 0,
                'at', to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'inputs', jsonb_build_object(
                    'contentId', "content"."id",
                    'contentSourceId', 'mail',
                    'contentRevision', "content"."revision"
                ),
                'steps', jsonb_build_object(
                    'title', jsonb_build_object(
                        'contentId', "content"."id",
                        'contentRevision', "content"."revision",
                        'generation', 0
                    ),
                    'summary', jsonb_build_object(
                        'contentId', "content"."id",
                        'contentRevision', "content"."revision",
                        'generation', 0
                    )
                )
            )
        )
    END,
    0,
    0,
    now(),
    now()
FROM "chatter_items" AS "item"
LEFT JOIN "mail_contents" AS "content"
  ON "content"."item_id" = "item"."id"
 AND "content"."user_id" = "item"."user_id"
WHERE "item"."kind" = 'mail'
  AND "item"."deleted_at" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "item_processing" AS "existing"
      WHERE "existing"."item_id" = "item"."id"
        AND "existing"."view" = 'private'
  );
