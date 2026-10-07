import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { people, recordingTasks } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";

/** One task as a backup archive carries it. */
export interface ArchivedTask {
    id: string;
    status: "open" | "done" | "dropped";
    text: string;
    assignee: { personId: string; name: string } | null;
    assigneeHint: string | null;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    source: string;
    createdAt: string;
    acceptedAt: string | null;
    statusChangedAt: string | null;
}

function optional(value: string | null): string | null {
    return value ? decryptText(value) : null;
}

/**
 * The accepted tasks of `userId`'s recordings, by recording, for their
 * backup archive and Markdown exports. Proposals waiting for review are
 * not tasks yet.
 */
export async function tasksForArchive(
    userId: string,
    recordingIds: readonly string[],
): Promise<Map<string, ArchivedTask[]>> {
    const byRecording = new Map<string, ArchivedTask[]>();
    if (recordingIds.length === 0) return byRecording;
    const rows = await db
        .select({
            id: recordingTasks.id,
            recordingId: recordingTasks.recordingId,
            status: recordingTasks.status,
            text: recordingTasks.text,
            assigneePersonId: recordingTasks.assigneePersonId,
            assigneeName: people.displayName,
            assigneeHint: recordingTasks.assigneeHint,
            dueDate: recordingTasks.dueDate,
            duePhrase: recordingTasks.duePhrase,
            quote: recordingTasks.quote,
            evidenceStartMs: recordingTasks.evidenceStartMs,
            source: recordingTasks.source,
            createdAt: recordingTasks.createdAt,
            acceptedAt: recordingTasks.acceptedAt,
            statusChangedAt: recordingTasks.statusChangedAt,
        })
        .from(recordingTasks)
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                eq(recordingTasks.userId, userId),
                inArray(recordingTasks.recordingId, [...recordingIds]),
                ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(recordingTasks.position, recordingTasks.createdAt);
    for (const row of rows) {
        const list = byRecording.get(row.recordingId) ?? [];
        list.push({
            id: row.id,
            status: row.status as ArchivedTask["status"],
            text: decryptText(row.text),
            assignee:
                row.assigneePersonId && row.assigneeName
                    ? {
                          personId: row.assigneePersonId,
                          name: decryptText(row.assigneeName),
                      }
                    : null,
            assigneeHint: optional(row.assigneeHint),
            dueDate: row.dueDate,
            duePhrase: optional(row.duePhrase),
            quote: optional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
            source: row.source,
            createdAt: row.createdAt.toISOString(),
            acceptedAt: row.acceptedAt?.toISOString() ?? null,
            statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
        });
        byRecording.set(row.recordingId, list);
    }
    return byRecording;
}
