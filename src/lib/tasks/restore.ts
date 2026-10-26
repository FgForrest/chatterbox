import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { lockPrivateFolderTree } from "@/db/queries/private-folder-tree";
import {
    chatterItems,
    people,
    recordingTasks,
    taskMentions,
    taskStatusTransitions,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { visibleOwnerCondition } from "@/lib/knowledge/org-people";
import { assertOrgScopeWritable } from "@/lib/org/config";
import {
    ANY_TASK_ITEM,
    type TaskViewer,
    taskClosable,
    taskRecordingShared,
    taskViewerById,
} from "@/lib/tasks/access";
import { loadTaskFolders } from "@/lib/tasks/folders";
import { isoDateOrNull } from "@/lib/tasks/summary-items";
import { setTaskFollowInTx } from "@/lib/tasks/tasks";

const archivedTask = z.object({
    id: z.string().min(1),
    status: z.enum(["proposed", "open", "done", "dropped"]),
    text: z.string().trim().min(1).max(2000),
    source: z.enum(["personal", "manual", "riffado", "plaud"]),
    folderId: z.string().min(1).nullable().optional(),
    assignee: z
        .object({ personId: z.string(), name: z.string() })
        .nullable()
        .default(null),
    assigneeHint: z.string().nullable().default(null),
    dueDate: z.string().nullable().default(null),
    duePhrase: z.string().nullable().default(null),
    quote: z.string().nullable().default(null),
    evidenceStartMs: z.number().int().nonnegative().nullable().default(null),
    evidenceText: z
        .object({
            segmentIndex: z.number().int().nonnegative(),
            charStart: z.number().int().nonnegative(),
            charEnd: z.number().int().positive(),
        })
        .optional(),
    evidenceProvenance: z
        .enum(["quoted", "unverified", "unlocated"])
        .optional(),
    note: z.string().max(2000).nullable().optional(),
    noteUpdatedAt: z.iso.datetime().nullable().optional(),
    noteUpdatedByUserId: z.string().nullable().optional(),
    createdAt: z.iso.datetime(),
    acceptedAt: z.iso.datetime().nullable().default(null),
    statusChangedAt: z.iso.datetime().nullable().default(null),
    statusTransitions: z
        .array(
            z.object({
                id: z.string().min(1),
                actorUserId: z.string().nullable(),
                fromStatus: z
                    .enum(["proposed", "open", "done", "dropped"])
                    .nullable(),
                toStatus: z.enum(["proposed", "open", "done", "dropped"]),
                createdAt: z.iso.datetime(),
            }),
        )
        .optional(),
    version: z.number().int().nonnegative().default(0),
    review: z
        .object({ ticked: z.boolean(), assigneeCheck: z.boolean() })
        .optional(),
});

const bundleSchema = z.object({
    folders: z
        .array(
            z.object({ id: z.string().min(1), restoredId: z.string().min(1) }),
        )
        .default([]),
    personal: z.array(archivedTask).default([]),
    items: z
        .array(z.object({ itemId: z.string(), tasks: z.array(archivedTask) }))
        .default([]),
    follows: z
        .array(
            z.object({
                taskId: z.string(),
                follow: z.boolean(),
                createdAt: z.iso.datetime(),
            }),
        )
        .default([]),
});

/** Restore task files and optional status history after items and people. Unknown historical actors become null. Older archives retain the legacy statistics fallback; existing tasks and their history stay unchanged. */
export async function restoreTaskArchive(
    viewer: TaskViewer,
    input: unknown,
): Promise<{ tasks: number; follows: number; skipped: number }> {
    const parsed = bundleSchema.safeParse(input);
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid task archive",
            400,
        );
    const bundle = parsed.data;
    if (viewer.isOrg) assertOrgScopeWritable();
    if (viewer.isOrg && (bundle.personal.length || bundle.follows.length))
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Own tasks and follows require a personal account",
            403,
        );
    return db.transaction(async (tx) => {
        await lockPrivateFolderTree(tx, viewer.userId);
        const privateFolders = bundle.folders.length
            ? await loadTaskFolders(viewer.userId, tx)
            : new Map();
        const folderMap = new Map<string, string>();
        for (const folder of bundle.folders) {
            if (viewer.isOrg || !privateFolders.has(folder.restoredId))
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Folder not found",
                    404,
                );
            if (folderMap.has(folder.id))
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Duplicate folder in archive",
                    400,
                );
            folderMap.set(folder.id, folder.restoredId);
        }
        const itemIds = bundle.items.map((item) => item.itemId);
        const items = itemIds.length
            ? await tx
                  .select({
                      id: chatterItems.id,
                      userId: chatterItems.userId,
                      shared: sql<boolean>`${taskRecordingShared(viewer, ANY_TASK_ITEM)}`,
                  })
                  .from(chatterItems)
                  .where(
                      and(
                          inArray(chatterItems.id, itemIds),
                          viewer.isOrg
                              ? taskRecordingShared(viewer, ANY_TASK_ITEM)
                              : eq(chatterItems.userId, viewer.userId),
                      ),
                  )
                  .for("update")
            : [];
        if (items.length !== new Set(itemIds).size)
            throw new AppError(
                ErrorCode.FORBIDDEN,
                "Restore items must belong to the archive scope",
                403,
            );
        const owners = new Map(items.map((item) => [item.id, item.userId]));
        const sharedItems = new Set(
            items.filter((item) => item.shared).map((item) => item.id),
        );
        const rows = [
            ...bundle.personal.map((task) => ({
                task,
                itemId: null,
                owner: viewer.userId,
            })),
            ...bundle.items.flatMap((item) =>
                item.tasks.map((task) => ({
                    task,
                    itemId: item.itemId,
                    owner: owners.get(item.itemId) as string,
                })),
            ),
        ];
        const ids = rows.map((row) => row.task.id);
        if (new Set(ids).size !== ids.length)
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Duplicate task in archive",
                400,
            );
        const existing = ids.length
            ? await tx
                  .select({
                      id: recordingTasks.id,
                      userId: recordingTasks.userId,
                  })
                  .from(recordingTasks)
                  .where(inArray(recordingTasks.id, ids))
            : [];
        if (
            existing.some(
                (row) =>
                    rows.find((candidate) => candidate.task.id === row.id)
                        ?.owner !== row.userId,
            )
        )
            throw new AppError(
                ErrorCode.CONFLICT,
                "An archived task id is already in use",
                409,
            );
        const known = new Set(existing.map((row) => row.id));
        let count = 0;
        for (const { task, itemId, owner } of rows) {
            if (
                (task.source === "personal") !== (itemId === null) ||
                (itemId !== null && task.folderId != null) ||
                (itemId === null && task.status === "proposed")
            )
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid own task",
                    400,
                );
            if (task.dueDate && !isoDateOrNull(task.dueDate))
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid due date",
                    400,
                );
            if (known.has(task.id)) continue;
            if (task.assignee && itemId) {
                const [person] = await tx
                    .select({ id: people.id })
                    .from(people)
                    .where(
                        and(
                            eq(people.id, task.assignee.personId),
                            sharedItems.has(itemId)
                                ? eq(people.userId, viewer.orgUserId ?? owner)
                                : visibleOwnerCondition(people.userId, owner),
                        ),
                    )
                    .limit(1);
                if (!person)
                    throw new AppError(
                        ErrorCode.INVALID_INPUT,
                        "Restore the task's assignee first",
                        400,
                    );
            }
            await tx.insert(recordingTasks).values({
                id: task.id,
                userId: owner,
                itemId,
                folderId:
                    itemId === null && task.folderId
                        ? (folderMap.get(task.folderId) ?? null)
                        : null,
                status: task.status,
                source: task.source,
                text: encryptText(task.text),
                note: task.note ? encryptText(task.note) : null,
                noteUpdatedAt: task.noteUpdatedAt
                    ? new Date(task.noteUpdatedAt)
                    : null,
                noteUpdatedByUserId: task.note ? viewer.userId : null,
                assigneePersonId: itemId ? task.assignee?.personId : null,
                assigneeHint: task.assigneeHint
                    ? encryptText(task.assigneeHint)
                    : null,
                dueDate: task.dueDate,
                duePhrase: task.duePhrase ? encryptText(task.duePhrase) : null,
                quote: task.quote ? encryptText(task.quote) : null,
                evidenceStartMs: task.evidenceStartMs,
                evidenceSegmentIndex: task.evidenceText?.segmentIndex,
                evidenceCharStart: task.evidenceText?.charStart,
                evidenceCharEnd: task.evidenceText?.charEnd,
                evidenceProvenance: task.evidenceProvenance,
                createdAt: new Date(task.createdAt),
                acceptedAt: task.acceptedAt ? new Date(task.acceptedAt) : null,
                statusChangedAt: task.statusChangedAt
                    ? new Date(task.statusChangedAt)
                    : null,
                version: task.version,
                createdByUserId: viewer.userId,
                ticked: task.review?.ticked ?? true,
                assigneeCheck: task.review?.assigneeCheck ?? false,
            });
            if (task.statusTransitions?.length) {
                const actorIds = [
                    ...new Set(
                        task.statusTransitions.flatMap((row) =>
                            row.actorUserId ? [row.actorUserId] : [],
                        ),
                    ),
                ];
                const actors = new Set(
                    actorIds.length
                        ? (
                              await tx
                                  .select({ id: users.id })
                                  .from(users)
                                  .where(inArray(users.id, actorIds))
                          ).map((row) => row.id)
                        : [],
                );
                await tx.insert(taskStatusTransitions).values(
                    task.statusTransitions.map((row) => ({
                        ...row,
                        taskId: task.id,
                        actorUserId:
                            row.actorUserId && actors.has(row.actorUserId)
                                ? row.actorUserId
                                : null,
                        createdAt: new Date(row.createdAt),
                    })),
                );
            }
            if (
                task.note &&
                task.noteUpdatedByUserId &&
                task.noteUpdatedByUserId !== viewer.userId
            ) {
                const [author] = await tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.id, task.noteUpdatedByUserId))
                    .limit(1);
                if (author) {
                    const authorViewer = await taskViewerById(author.id);
                    const [closable] = await tx
                        .select({ id: recordingTasks.id })
                        .from(recordingTasks)
                        .leftJoin(
                            chatterItems,
                            eq(chatterItems.id, recordingTasks.itemId),
                        )
                        .where(
                            and(
                                eq(recordingTasks.id, task.id),
                                taskClosable(authorViewer, ANY_TASK_ITEM, true),
                            ),
                        )
                        .limit(1);
                    if (closable)
                        await tx
                            .update(recordingTasks)
                            .set({ noteUpdatedByUserId: author.id })
                            .where(
                                and(
                                    eq(recordingTasks.id, task.id),
                                    eq(recordingTasks.userId, owner),
                                ),
                            );
                }
            }
            if (itemId)
                await tx.insert(taskMentions).values({
                    taskId: task.id,
                    itemId,
                    userId: owner,
                    view: viewer.isOrg ? "org" : "private",
                    matchDecision: "home",
                    statementAt: new Date(task.createdAt),
                    quote: task.quote ? encryptText(task.quote) : null,
                });
            count++;
        }
        let follows = 0;
        for (const follow of bundle.follows) {
            if (
                await setTaskFollowInTx(
                    tx,
                    viewer,
                    follow.taskId,
                    follow.follow,
                    new Date(follow.createdAt),
                )
            )
                follows++;
        }
        return {
            tasks: count,
            follows,
            skipped: existing.length + bundle.follows.length - follows,
        };
    });
}
