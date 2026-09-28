-- A shared recording is one recording (plan rev 2.2). Before this release the
-- Organization view could hold rows of its own, owned by the organization
-- account: a transcript re-run on that view, its speaker names, a summary
-- made there. Here they become the recording's own, once.
--
-- On a recording still shared, per source the Organization's transcript
-- replaces its owner's ("the Organization's names win"): the owner's goes,
-- with its speaker rows, and the Organization's, its speaker rows and
-- rejections pass to the owner. Summaries likewise, and a summary made from
-- a transcript replaced here names its replacement. On a recording no longer
-- shared the organization account's rows are left from a path around the
-- unshare, and go.
DELETE FROM "ai_enhancements" AS "e"
USING "users" AS "u"
WHERE "e"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND NOT EXISTS (
      SELECT 1
      FROM "recording_folder_assignments" AS "a"
      JOIN "recording_folders" AS "f" ON "f"."id" = "a"."folder_id"
      JOIN "users" AS "fu" ON "fu"."id" = "f"."user_id"
      WHERE "a"."recording_id" = "e"."recording_id"
        AND "fu"."role" = 'org'
  );
--> statement-breakpoint
DELETE FROM "transcriptions" AS "t"
USING "users" AS "u"
WHERE "t"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND NOT EXISTS (
      SELECT 1
      FROM "recording_folder_assignments" AS "a"
      JOIN "recording_folders" AS "f" ON "f"."id" = "a"."folder_id"
      JOIN "users" AS "fu" ON "fu"."id" = "f"."user_id"
      WHERE "a"."recording_id" = "t"."recording_id"
        AND "fu"."role" = 'org'
  );
--> statement-breakpoint
UPDATE "ai_enhancements" AS "e"
SET "transcription_id" = "org"."id"
FROM "transcriptions" AS "org"
JOIN "users" AS "u" ON "u"."id" = "org"."user_id" AND "u"."role" = 'org'
JOIN "recordings" AS "r" ON "r"."id" = "org"."recording_id"
JOIN "transcriptions" AS "own"
  ON "own"."recording_id" = "org"."recording_id"
 AND "own"."user_id" = "r"."user_id"
 AND "own"."source" = "org"."source"
WHERE "e"."transcription_id" = "own"."id";
--> statement-breakpoint
DELETE FROM "transcriptions" AS "own"
USING "transcriptions" AS "org", "users" AS "u", "recordings" AS "r"
WHERE "org"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND "r"."id" = "org"."recording_id"
  AND "own"."recording_id" = "org"."recording_id"
  AND "own"."user_id" = "r"."user_id"
  AND "own"."source" = "org"."source";
--> statement-breakpoint
UPDATE "transcript_speakers" AS "s"
SET "user_id" = "r"."user_id", "updated_at" = now()
FROM "transcriptions" AS "org"
JOIN "users" AS "u" ON "u"."id" = "org"."user_id" AND "u"."role" = 'org'
JOIN "recordings" AS "r" ON "r"."id" = "org"."recording_id"
WHERE "s"."transcription_id" = "org"."id";
--> statement-breakpoint
UPDATE "transcript_speaker_rejections" AS "s"
SET "user_id" = "r"."user_id"
FROM "transcriptions" AS "org"
JOIN "users" AS "u" ON "u"."id" = "org"."user_id" AND "u"."role" = 'org'
JOIN "recordings" AS "r" ON "r"."id" = "org"."recording_id"
WHERE "s"."transcription_id" = "org"."id";
--> statement-breakpoint
UPDATE "transcriptions" AS "org"
SET "user_id" = "r"."user_id"
FROM "users" AS "u", "recordings" AS "r"
WHERE "org"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND "r"."id" = "org"."recording_id";
--> statement-breakpoint
DELETE FROM "ai_enhancements" AS "own"
USING "ai_enhancements" AS "org", "users" AS "u", "recordings" AS "r"
WHERE "org"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND "r"."id" = "org"."recording_id"
  AND "own"."recording_id" = "org"."recording_id"
  AND "own"."user_id" = "r"."user_id"
  AND "own"."source" = "org"."source";
--> statement-breakpoint
UPDATE "ai_enhancements" AS "org"
SET "user_id" = "r"."user_id"
FROM "users" AS "u", "recordings" AS "r"
WHERE "org"."user_id" = "u"."id"
  AND "u"."role" = 'org'
  AND "r"."id" = "org"."recording_id";
