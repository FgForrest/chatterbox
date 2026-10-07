import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { people, recordings, recordingTasks } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    type ArchiveScope,
    archivedRecordingCondition,
} from "@/lib/export/archive-scope";

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
 * Whose tasks an archive or a Markdown document carries: a backup's scope,
 * or every task of the owner's recordings (`owner`, the documents rendered
 * from the owner's rows).
 */
export type TaskArchiveScope = ArchiveScope | { kind: "owner"; userId: string };

// A person's own: on a recording they shared, the tasks the summaries
// proposed and those they added, not those the Organization added by hand.
// The Organization's: every task of the shared recordings it carries.
function archivedTaskCondition(scope: TaskArchiveScope): SQL | undefined {
    if (scope.kind === "organization") {
        return archivedRecordingCondition(scope);
    }
    if (scope.kind === "owner") return eq(recordingTasks.userId, scope.userId);
    return and(
        eq(recordingTasks.userId, scope.userId),
        or(
            ne(recordingTasks.source, "manual"),
            eq(recordingTasks.createdByUserId, scope.userId),
        ),
    );
}

/**
 * The accepted tasks of `recordingIds` a scope carries, by recording, for
 * backup archives and Markdown exports. Proposals waiting for review are
 * not tasks yet.
 */
export async function tasksForArchive(
    scope: TaskArchiveScope,
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
        .innerJoin(
            recordings,
            and(
                eq(recordings.id, recordingTasks.recordingId),
                eq(recordings.userId, recordingTasks.userId),
            ),
        )
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                archivedTaskCondition(scope),
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
