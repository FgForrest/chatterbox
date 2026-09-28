-- Decision D1 (a), applied once. Before this release, a recording's first
-- own transcription copied the names confirmed on Plaud's transcript onto
-- it as confirmed rows, mapped by speaker order; they would now pass for a
-- person's answer. 0058 added confirmed_by_user_id empty on every row and
-- nothing since has written one, so here a confirmed row without a
-- confirmer is exactly one stored before this release.
--
-- Such a row naming a person, on a Riffado transcript, whose recording has
-- a Plaud transcript of the same user with a confirmed row naming the same
-- person, becomes a heuristic suggestion. A few genuine confirmations match
-- too; the owner accepts them again with one click.
UPDATE "transcript_speakers" AS "copied"
SET "status" = 'suggested', "source" = 'heuristic', "updated_at" = now()
FROM "transcriptions" AS "own"
WHERE "copied"."transcription_id" = "own"."id"
  AND "copied"."status" = 'confirmed'
  AND "copied"."confirmed_by_user_id" IS NULL
  AND "copied"."person_id" IS NOT NULL
  AND "own"."source" = 'riffado'
  AND EXISTS (
      SELECT 1
      FROM "transcriptions" AS "plaud"
      JOIN "transcript_speakers" AS "named"
        ON "named"."transcription_id" = "plaud"."id"
      WHERE "plaud"."recording_id" = "own"."recording_id"
        AND "plaud"."user_id" = "own"."user_id"
        AND "plaud"."source" = 'plaud'
        AND "named"."status" = 'confirmed'
        AND "named"."person_id" = "copied"."person_id"
  );
