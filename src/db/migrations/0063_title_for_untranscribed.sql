-- 0060 protected every existing title, as set by a person (decision D2 a).
-- A recording that was never transcribed still carries the name it came
-- with, and before this release its first transcription would have replaced
-- that with a generated title: it keeps doing so. Nothing has written
-- title_edited_at since 0060, so every value here is that stamp.
--
-- A recording whose transcript retention removed was transcribed, and its
-- title may be one a person chose: it stays protected.
UPDATE "recordings"
SET "title_edited_at" = NULL
WHERE "transcript_reaped_at" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "transcriptions"
      WHERE "transcriptions"."recording_id" = "recordings"."id"
  );
