UPDATE "task_update_proposals" AS proposal
SET "statement_at" = COALESCE(
    (
        SELECT mention."statement_at"
        FROM "task_mentions" AS mention
        WHERE mention."task_id" = proposal."task_id"
          AND mention."item_id" = proposal."recording_id"
          AND mention."user_id" = proposal."user_id"
        ORDER BY
            (mention."id" = proposal."id") DESC,
            (
                mention."evidence_start_ms" IS NOT DISTINCT FROM proposal."evidence_start_ms"
                AND mention."evidence_segment_index" IS NOT DISTINCT FROM proposal."evidence_segment_index"
                AND mention."evidence_char_start" IS NOT DISTINCT FROM proposal."evidence_char_start"
                AND mention."evidence_char_end" IS NOT DISTINCT FROM proposal."evidence_char_end"
                AND mention."provenance" IS NOT DISTINCT FROM proposal."evidence_provenance"
            ) DESC,
            mention."created_at" DESC
        LIMIT 1
    ),
    (
        SELECT item."occurred_at"
        FROM "chatter_items" AS item
        WHERE item."id" = proposal."recording_id"
          AND item."user_id" = proposal."user_id"
    ),
    proposal."created_at"
)
WHERE proposal."statement_at" IS DISTINCT FROM COALESCE(
    (
        SELECT mention."statement_at"
        FROM "task_mentions" AS mention
        WHERE mention."task_id" = proposal."task_id"
          AND mention."item_id" = proposal."recording_id"
          AND mention."user_id" = proposal."user_id"
        ORDER BY
            (mention."id" = proposal."id") DESC,
            (
                mention."evidence_start_ms" IS NOT DISTINCT FROM proposal."evidence_start_ms"
                AND mention."evidence_segment_index" IS NOT DISTINCT FROM proposal."evidence_segment_index"
                AND mention."evidence_char_start" IS NOT DISTINCT FROM proposal."evidence_char_start"
                AND mention."evidence_char_end" IS NOT DISTINCT FROM proposal."evidence_char_end"
                AND mention."provenance" IS NOT DISTINCT FROM proposal."evidence_provenance"
            ) DESC,
            mention."created_at" DESC
        LIMIT 1
    ),
    (
        SELECT item."occurred_at"
        FROM "chatter_items" AS item
        WHERE item."id" = proposal."recording_id"
          AND item."user_id" = proposal."user_id"
    ),
    proposal."created_at"
);
