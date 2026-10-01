/**
 * What the Almanac's editing routes share: a bounded JSON body, and the
 * exports to plan again when a name they carry changes.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transcriptCorrections, transcriptions } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { readBoundedJson } from "@/lib/http/bounded-json";

/** The request's JSON object, at most `maxBytes`; `{}` for anything else. */
export async function jsonBody(
    request: Request,
    maxBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
    const read = await readBoundedJson(request, maxBytes);
    if (read.tooLarge) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    }
    const body = read.body;
    return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
}

/**
 * Every account whose exports may carry these entities' names: whoever
 * made a correction linking to one (the Organization, on a shared
 * recording) and the owner of the transcript it is on.
 */
export async function accountsNamingEntities(
    entityIds: readonly string[],
): Promise<string[]> {
    if (entityIds.length === 0) return [];
    const rows = await db
        .selectDistinct({
            scope: transcriptCorrections.userId,
            owner: transcriptions.userId,
        })
        .from(transcriptCorrections)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptCorrections.transcriptionId),
        )
        .where(inArray(transcriptCorrections.targetEntityId, [...entityIds]));
    return [...new Set(rows.flatMap((row) => [row.scope, row.owner]))];
}

/**
 * Exported Markdown carries the names corrections link to, so a rename,
 * merge or erasure plans those accounts' exports again.
 */
export async function replanExports(accounts: Iterable<string>): Promise<void> {
    for (const userId of new Set(accounts)) {
        await enqueueExportPlansForUser(userId).catch((error) => {
            console.error("Failed to schedule export re-plan:", error);
        });
    }
}
