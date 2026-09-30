-- Transcripts written before audio_md5 existed take the audio their recording has now:
-- the best knowledge there is, and a trim synced from here on is then noticed.
UPDATE "transcriptions" AS t
SET "audio_md5" = r."file_md5"
FROM "recordings" AS r
WHERE r."id" = t."recording_id" AND t."audio_md5" IS NULL AND r."file_md5" IS NOT NULL;
