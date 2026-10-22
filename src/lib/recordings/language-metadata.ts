import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import { aiEnhancements, chatterItems, recordings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { detectLanguage } from "@/lib/knowledge/stemming/detect-language";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import {
    normalizeDetectedLanguage,
    recordingOutputLanguage,
} from "@/lib/recordings/language";
import type { RecordingView } from "@/lib/sharing/view";

/** Language metadata and a manual regeneration offer, without queueing work. */
export async function recordingLanguageMetadata(
    userId: string,
    recordingId: string,
    view: RecordingView = "private",
    actorUserId = userId,
) {
    const [[row], summaries] = await Promise.all([
        db
            .select({
                confirmedLanguage: recordings.confirmedLanguage,
                title: chatterItems.title,
                titleEditedAt: chatterItems.titleEditedAt,
            })
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1),
        db
            .select({
                summary: aiEnhancements.summary,
                outputLanguage: aiEnhancements.outputLanguage,
                source: aiEnhancements.source,
            })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, userId),
                ),
            ),
    ]);
    const summary =
        summaries.find((item) => item.source === "riffado") ??
        summaries.find((item) => item.source === "plaud");
    const confirmedLanguage = row?.confirmedLanguage ?? null;
    const summaryLanguage = summary?.summary
        ? (normalizeDetectedLanguage(summary.outputLanguage) ??
          detectLanguage(decryptText(summary.summary)))
        : null;
    const titleLanguage =
        row && !row.titleEditedAt
            ? detectLanguage(decryptText(row.title))
            : null;
    const profile = row
        ? await resolveManualItemProfile(
              recordingId,
              view,
              userId,
              actorUserId,
          ).catch((error: unknown) => {
              if (
                  error instanceof AppError &&
                  error.code === ErrorCode.CONFLICT
              )
                  return null;
              throw error;
          })
        : null;
    if (!profile) return { confirmedLanguage, needsResummary: false };
    const outputLanguage = recordingOutputLanguage(
        profile.settings.steps.summary.outputLanguage,
        confirmedLanguage,
    );
    const needsResummary = Boolean(
        outputLanguage &&
            ((summary?.summary && summaryLanguage !== outputLanguage) ||
                (titleLanguage && titleLanguage !== outputLanguage)),
    );
    return { confirmedLanguage, needsResummary };
}
