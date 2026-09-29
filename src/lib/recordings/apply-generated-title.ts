import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import {
    storeGeneratedTitle,
    titleStillGenerated,
} from "@/lib/recordings/generated-title";

/**
 * Generate a title from a transcript and make it the recording's name:
 * stored unless a person set one (`storeGeneratedTitle`), the export
 * re-planned under it, and sent to Plaud when the person asked for that.
 * Returns whether the recording was renamed. Runs inline after a
 * transcription, or as the title job when automatic Learn held it back.
 * Throws only what generating the title throws; Plaud trouble is logged.
 */
export async function applyGeneratedTitle(input: {
    userId: string;
    recordingId: string;
    text: string;
    plaudFileId: string;
    syncTitleToPlaud: boolean;
}): Promise<boolean> {
    const { userId, recordingId, text, plaudFileId, syncTitleToPlaud } = input;
    if (!text.trim()) return false;
    const generatedTitle = await generateTitleFromTranscription(userId, text);

    // Not stored when a person has set a title, and then nothing below runs.
    const retitled = generatedTitle
        ? await storeGeneratedTitle(userId, recordingId, generatedTitle)
        : false;
    if (!generatedTitle || !retitled) return false;

    // The export was planned under the old title; plan again so its
    // directory follows the rename now.
    await refreshExistingRecordingSidecars(userId, recordingId);

    if (syncTitleToPlaud) {
        try {
            const [connection] = await db
                .select()
                .from(plaudConnections)
                .where(eq(plaudConnections.userId, userId))
                .limit(1);

            if (connection) {
                const plaudClient = await createPlaudClient(
                    connection.bearerToken,
                    connection.apiBase,
                    connection.workspaceId,
                );
                // A person may have renamed it since the title was stored.
                // Their title stays here, so Plaud must not get this one.
                if (await titleStillGenerated(userId, recordingId)) {
                    await plaudClient.updateFilename(
                        plaudFileId,
                        generatedTitle,
                    );
                }
                // Backfill workspaceId if newly resolved. Always scope
                // user-owned UPDATEs by userId even when filtering by id
                // (per AGENTS.md).
                const resolved = plaudClient.workspaceId;
                if (resolved && resolved !== connection.workspaceId) {
                    await db
                        .update(plaudConnections)
                        .set({ workspaceId: resolved })
                        .where(
                            and(
                                eq(plaudConnections.id, connection.id),
                                eq(plaudConnections.userId, userId),
                            ),
                        );
                }
            }
        } catch (error) {
            console.error("Failed to sync title to Plaud:", error);
        }
    }
    return true;
}
