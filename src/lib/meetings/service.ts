import {
    and,
    asc,
    desc,
    eq,
    getTableColumns,
    inArray,
    isNull,
    ne,
    notInArray,
    or,
    sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db } from "@/db";
import {
    bumpAgendaInTx,
    publishAgendaEventInTx,
} from "@/db/queries/agenda-events";
import { hasVisibleAgendaSources } from "@/db/queries/agenda-source-visibility";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import {
    receivedMeetingFilings,
    receivedMeetingShares,
} from "@/db/queries/meeting-shares";
import {
    listMeetingRows,
    lockMeetingEvent,
    type MeetingTx,
    meetingFolders,
    meetingVisibility,
} from "@/db/queries/meetings";
import {
    ANY_TASK_ITEM,
    type TaskViewer,
    taskVisible,
} from "@/db/queries/task-visibility";
import {
    agendaPoints,
    agendaSuggestions,
    agendaTasks,
    asyncJobs,
    chatterItems,
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    taskMentions,
    users,
} from "@/db/schema";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    assertCategorizableFolder,
    lockCategorizableFolderInTx,
    removeRecordingFromFolder,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import { getCalendarEvent } from "@/lib/integrations/google/calendar-events";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import {
    meetingRecordingRedirect,
    meetingViewer,
    requireMeetingAccess,
} from "@/lib/meetings/access";
import { meetingAttachmentAudienceInTx } from "@/lib/meetings/attachment-audience";
import {
    calendarSnapshotWithEditors,
    encryptCalendarSnapshot,
    readMeetingCalendarSnapshot,
} from "@/lib/meetings/calendar-snapshot";
import { meetingFolderNavigation } from "@/lib/meetings/folders";
import { meetingInvitees } from "@/lib/meetings/meeting-roster";
import {
    agendaTaskIdsInput,
    createMeetingInput,
    createPointInput,
    groupAgendaTasks,
    patchMeetingInput,
    patchPointInput,
    validatePointTree,
} from "@/lib/meetings/model";
import { OLDER_TASK_POSITION_BASE } from "@/lib/meetings/positions";
import { agendaRecordingBy } from "@/lib/meetings/recording-by";
import { agendaSuggestionsAvailability } from "@/lib/meetings/suggestions-provider";
import {
    deletePointTextDocsInTx,
    replaceAgendaTextInTx,
} from "@/lib/meetings/text-documents";
import { listVisibleItemFolders } from "@/lib/sharing/person-shares";
import { taskViewerById } from "@/lib/tasks/access";
import { getVisibleTasks } from "@/lib/tasks/tasks";

type Agenda = typeof meetingAgendas.$inferSelect;
type Access = Awaited<ReturnType<typeof requireMeetingAccess>>;

function invalid(message: string): never {
    throw new AppError(ErrorCode.INVALID_INPUT, message, 400);
}
function whereAgenda(agenda: Agenda) {
    return and(
        eq(meetingAgendas.id, agenda.id),
        eq(meetingAgendas.userId, agenda.userId),
    );
}
function pointWhere(agenda: Agenda) {
    return and(
        eq(agendaPoints.agendaId, agenda.id),
        eq(agendaPoints.userId, agenda.userId),
    );
}

function readPoint({
    sources: _sources,
    ...point
}: typeof agendaPoints.$inferSelect) {
    return {
        ...point,
        text: decryptText(point.text),
        note: point.note ? decryptText(point.note) : null,
    };
}

/** Bump the polling version in the same transaction as an agenda edit. */
export async function bumpAgenda(tx: MeetingTx, agenda: Agenda) {
    await bumpAgendaInTx(tx, agenda);
}

async function editMeeting<T>(
    userId: string,
    id: string,
    mode: "edit" | "manage",
    run: (tx: MeetingTx, access: Access) => Promise<T>,
    participant = false,
): Promise<T> {
    const viewer = await meetingViewer(userId);
    return db.transaction(async (tx) => {
        const access = await requireMeetingAccess(userId, id, mode, {
            viewer,
            executor: tx,
            lock: true,
        });
        const result = await run(tx, access);
        if (result === false) return result;
        if (participant)
            await tx
                .update(meetingAgendas)
                .set({
                    calendarSnapshot: sql`coalesce(${meetingAgendas.calendarSnapshot}, '{}'::jsonb) || jsonb_build_object('editorUserIds', coalesce(${meetingAgendas.calendarSnapshot}->'editorUserIds', '[]'::jsonb) || ${JSON.stringify([userId])}::jsonb)`,
                })
                .where(
                    and(
                        whereAgenda(access.agenda),
                        sql`not coalesce(${meetingAgendas.calendarSnapshot}->'editorUserIds', '[]'::jsonb) @> ${JSON.stringify([userId])}::jsonb`,
                    ),
                );
        await bumpAgenda(tx, access.agenda);
        return result;
    });
}

async function snapshotTasks(
    tx: MeetingTx,
    agenda: Agenda,
    folderIds: readonly string[],
    viewer: TaskViewer,
    retainNotes = false,
) {
    let sourceId = agenda.taskSourceItemId;
    if (sourceId) {
        const [source] = await tx
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, sourceId),
                    eq(chatterItems.kind, "audio"),
                    meetingVisibility(viewer.userId, viewer.orgUserId),
                ),
            );
        if (!source) invalid("Task source is not a visible recording");
    } else {
        const [source] = await tx
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .innerJoin(recordings, eq(recordings.id, chatterItems.id))
            .where(
                and(
                    meetingVisibility(viewer.userId, viewer.orgUserId),
                    agenda.plannedStart
                        ? sql`${chatterItems.occurredAt} < ${agenda.plannedStart.toISOString()}::timestamp`
                        : undefined,
                    agenda.calendarSeriesId
                        ? eq(
                              recordings.calendarSeriesId,
                              agenda.calendarSeriesId,
                          )
                        : sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = ${chatterItems.id} and ${inArray(recordingFolderAssignments.folderId, [...folderIds])})`,
                    agenda.calendarSeriesId
                        ? undefined
                        : sql`exists (select 1 from ${recordingTasks} where ${recordingTasks.itemId} = ${chatterItems.id} and ${recordingTasks.status} in ('open', 'done'))`,
                ),
            )
            .orderBy(desc(chatterItems.occurredAt), desc(chatterItems.id))
            .limit(1);
        sourceId = source?.id ?? null;
    }
    await tx
        .update(meetingAgendas)
        .set({ snapshotSourceItemId: sourceId })
        .where(whereAgenda(agenda));
    const tasks = await tx
        .select({ id: recordingTasks.id })
        .from(recordingTasks)
        .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(
            and(
                inArray(recordingTasks.status, ["open", "done"]),
                taskVisible(viewer, ANY_TASK_ITEM, true),
                or(
                    sourceId ? eq(recordingTasks.itemId, sourceId) : sql`false`,
                    sourceId
                        ? sql`exists (select 1 from ${taskMentions} where ${taskMentions.taskId} = ${recordingTasks.id} and ${taskMentions.itemId} = ${sourceId} and ${taskMentions.matchDecision} in ('home', 'accepted', 'kept_new'))`
                        : sql`false`,
                ),
            ),
        )
        .orderBy(asc(recordingTasks.position), asc(recordingTasks.id));
    await tx.delete(agendaTasks).where(
        and(
            eq(agendaTasks.agendaId, agenda.id),
            eq(agendaTasks.userId, agenda.userId),
            eq(agendaTasks.origin, "last_meeting"),
            retainNotes ? isNull(agendaTasks.note) : undefined,
            tasks.length
                ? notInArray(
                      agendaTasks.taskId,
                      tasks.map((task) => task.id),
                  )
                : undefined,
        ),
    );
    if (tasks.length)
        await tx
            .insert(agendaTasks)
            .values(
                tasks.map((task, position) => ({
                    userId: agenda.userId,
                    agendaId: agenda.id,
                    taskId: task.id,
                    origin: "last_meeting" as const,
                    position,
                })),
            )
            .onConflictDoNothing();
}

async function carryOverInFolders(
    tx: MeetingTx,
    access: { agenda: Agenda; item: { id: string } },
    folderIds: readonly string[],
    userId: string,
    orgUserId: string | null,
) {
    const [previous] = await tx
        .select({ agenda: meetingAgendas })
        .from(meetingAgendas)
        .innerJoin(
            chatterItems,
            eq(
                chatterItems.id,
                sql`coalesce(${meetingAgendas.recordingItemId}, ${meetingAgendas.meetingItemId})`,
            ),
        )
        .where(
            and(
                meetingVisibility(userId, orgUserId),
                ne(meetingAgendas.id, access.agenda.id),
                or(
                    eq(meetingAgendas.state, "held"),
                    sql`${meetingAgendas.recordingItemId} is not null`,
                ),
                sql`${meetingAgendas.createdAt} < ${access.agenda.createdAt.toISOString()}::timestamp`,
                sql`coalesce(${meetingAgendas.plannedStart}, ${meetingAgendas.createdAt}) < ${(access.agenda.plannedStart ?? access.agenda.createdAt).toISOString()}::timestamp`,
                sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = coalesce(${meetingAgendas.recordingItemId}, ${meetingAgendas.meetingItemId}) and ${inArray(recordingFolderAssignments.folderId, [...folderIds])})`,
            ),
        )
        .orderBy(
            ...(access.agenda.calendarSeriesId
                ? [
                      desc(
                          sql`${meetingAgendas.calendarSeriesId} is not distinct from ${access.agenda.calendarSeriesId}`,
                      ),
                  ]
                : []),
            desc(
                sql`coalesce(${meetingAgendas.plannedStart}, ${meetingAgendas.createdAt})`,
            ),
            desc(meetingAgendas.createdAt),
        )
        .limit(1);
    if (!previous) return;
    const points = await tx
        .select()
        .from(agendaPoints)
        .where(
            and(
                pointWhere(previous.agenda),
                previous.agenda.recordingItemId
                    ? eq(agendaPoints.summaryOutcome, "not_covered")
                    : isNull(agendaPoints.discussedAt),
            ),
        );
    const existing = await tx
        .select({ originPointId: agendaSuggestions.originPointId })
        .from(agendaSuggestions)
        .where(
            and(
                eq(agendaSuggestions.agendaId, access.agenda.id),
                eq(agendaSuggestions.userId, access.agenda.userId),
            ),
        );
    const offered = points.filter(
        (point) =>
            !existing.some(
                (suggestion) => suggestion.originPointId === point.id,
            ),
    );
    if (offered.length) {
        await tx.insert(agendaSuggestions).values(
            offered.map((point) => ({
                agendaId: access.agenda.id,
                userId: access.agenda.userId,
                kind: "carry_over" as const,
                text: point.text,
                originPointId: point.id,
                sources: {
                    itemIds: [
                        ...new Set(
                            [
                                previous.agenda.recordingItemId ??
                                    previous.agenda.meetingItemId ??
                                    "",
                                ...(point.sources?.itemIds ?? []),
                            ].filter(Boolean),
                        ),
                    ],
                    taskIds: [...new Set(point.sources?.taskIds ?? [])],
                },
                createdByUserId: userId,
            })),
        );
    }
}

async function carryOver(
    tx: MeetingTx,
    access: { agenda: Agenda; item: { id: string } },
    folderIds: readonly string[],
    userId: string,
    orgUserId: string | null,
) {
    for (const folderId of [...new Set(folderIds)])
        await carryOverInFolders(tx, access, [folderId], userId, orgUserId);
}

/** Reconsider automatic preparation when the owner explicitly changes a planned agenda's filing. */
export async function refreshMeetingFolderContext(
    ownerUserId: string,
    itemId: string,
) {
    const tasksViewer = {
        ...(await taskViewerById(ownerUserId)),
        includeReceived: true,
    };
    await editMeeting(ownerUserId, itemId, "manage", async (tx, access) => {
        if (access.agenda.state !== "planned") return false;
        const folders = await meetingFolders(tx, itemId, ownerUserId);
        const folderIds = folders.map((folder) => folder.id);
        if (!folderIds.length && !access.agenda.snapshotSourceItemId)
            return false;
        if (!access.agenda.taskSourceItemId)
            await snapshotTasks(
                tx,
                access.agenda,
                folderIds,
                tasksViewer,
                true,
            );
        await carryOver(
            tx,
            access,
            folderIds,
            ownerUserId,
            access.viewer.orgUserId,
        );
    });
}

/** Create and file a meeting, returning a visible existing event agenda on repeated requests. */
export async function prepareMeeting(
    userId: string,
    raw: z.input<typeof createMeetingInput>,
) {
    const input = createMeetingInput.parse(raw);
    const [folder, viewer, tasksViewer] = await Promise.all([
        assertCategorizableFolder(userId, input.folderId),
        meetingViewer(userId),
        taskViewerById(userId).then((viewer) => ({
            ...viewer,
            includeReceived: true,
        })),
    ]);
    const event = input.calendarEventId
        ? await getCalendarEvent(userId, input.calendarEventId)
        : null;
    const start = event
        ? new Date(event.start)
        : input.start
          ? new Date(input.start)
          : null;
    const end = event
        ? new Date(event.end)
        : input.end
          ? new Date(input.end)
          : null;
    const title = event?.title ?? input.title;
    if (!title) invalid("Provide a title or calendar event");
    if (end && (!start || end <= start))
        invalid("Meeting end must follow its start");
    const result = await db.transaction(async (tx) => {
        if (event) {
            await lockMeetingEvent(tx, event.id);
            const [existing] = await listMeetingRows(
                userId,
                viewer.orgUserId,
                {
                    calendarEventId: event.id,
                    includePast: true,
                    includeAbsorbed: true,
                },
                tx,
            );
            if (existing) return { id: existing.agenda.id, existing: true };
        }
        if (folder.scope !== "org")
            await lockCategorizableFolderInTx(tx, userId, folder.folderId);
        const itemId = nanoid();
        const at = new Date();
        await tx.insert(chatterItems).values({
            id: itemId,
            userId,
            kind: "meeting",
            title: encryptText(title),
            occurredAt: start ?? at,
        });
        const [agenda] = await tx
            .insert(meetingAgendas)
            .values({
                userId,
                meetingItemId: itemId,
                calendarEventId: event?.id,
                calendarSeriesId: event?.recurringEventId,
                calendarSnapshot: event ? encryptCalendarSnapshot(event) : null,
                calendarRefreshedAt: event ? at : null,
                plannedStart: start,
                plannedEnd: end,
                timeSet: start !== null,
            })
            .returning();
        if (folder.scope === "org")
            await shareItemToOrganizationFolderInTx(tx, {
                ownerUserId: userId,
                itemId,
                folderId: folder.folderId,
                orgUserId: folder.ownerId,
            });
        else
            await tx
                .insert(recordingFolderAssignments)
                .values({ userId, itemId, folderId: folder.folderId });
        await notifyFolderReceiversInTx(tx, userId, itemId, folder.folderId);
        await snapshotTasks(tx, agenda, [folder.folderId], tasksViewer);
        await carryOver(
            tx,
            { agenda, item: { id: itemId } },
            [folder.folderId],
            userId,
            viewer.orgUserId,
        );
        return { id: agenda.id, existing: false };
    });
    return { ...result, meeting: await getMeeting(userId, result.id) };
}

/** List visible meetings with bounded payloads for calendar picking and recorder reminders. */
export async function listMeetings(
    userId: string,
    input: Parameters<typeof listMeetingRows>[2] = {},
) {
    const viewer = await meetingViewer(userId);
    const [rows, navigation] = await Promise.all([
        listMeetingRows(userId, viewer.orgUserId, input),
        meetingFolderNavigation(userId, viewer.orgUserId),
    ]);
    const attachedIds = rows.flatMap(({ agenda }) =>
        agenda.recordingItemId ? [agenda.recordingItemId] : [],
    );
    const [folders, editors, visibleRecordings] = await Promise.all([
        rows.length
            ? db
                  .select({
                      itemId: recordingFolderAssignments.itemId,
                      id: recordingFolders.id,
                      name: recordingFolders.name,
                      userId: recordingFolders.userId,
                      parentId: recordingFolders.parentId,
                  })
                  .from(recordingFolderAssignments)
                  .innerJoin(
                      recordingFolders,
                      eq(
                          recordingFolders.id,
                          recordingFolderAssignments.folderId,
                      ),
                  )
                  .where(
                      and(
                          inArray(
                              recordingFolderAssignments.itemId,
                              rows.flatMap(({ agenda }) =>
                                  agenda.meetingItemId
                                      ? [agenda.meetingItemId]
                                      : [],
                              ),
                          ),
                          or(
                              ...rows.flatMap(({ agenda }) =>
                                  agenda.meetingItemId
                                      ? [
                                            and(
                                                eq(
                                                    recordingFolderAssignments.itemId,
                                                    agenda.meetingItemId,
                                                ),
                                                eq(
                                                    recordingFolderAssignments.userId,
                                                    agenda.userId,
                                                ),
                                            ),
                                        ]
                                      : [],
                              ),
                          ),
                      ),
                  )
            : [],
        rows.length
            ? db
                  .selectDistinct({
                      agendaId: agendaPoints.agendaId,
                      id: users.id,
                      name: users.name,
                  })
                  .from(agendaPoints)
                  .innerJoin(users, eq(users.id, agendaPoints.authorUserId))
                  .where(
                      or(
                          ...rows.map(({ agenda }) =>
                              and(
                                  eq(agendaPoints.agendaId, agenda.id),
                                  eq(agendaPoints.userId, agenda.userId),
                              ),
                          ),
                      ),
                  )
            : [],
        attachedIds.length
            ? db
                  .select({ id: chatterItems.id })
                  .from(chatterItems)
                  .where(
                      and(
                          inArray(chatterItems.id, attachedIds),
                          meetingVisibility(userId, viewer.orgUserId),
                      ),
                  )
            : [],
    ]);
    const visibleRecordingIds = new Set(visibleRecordings.map((row) => row.id));
    const itemIds = rows.flatMap(({ agenda }) =>
        agenda.meetingItemId ? [agenda.meetingItemId] : [],
    );
    const [filings, receipts] = await Promise.all([
        receivedMeetingFilings(userId, itemIds),
        receivedMeetingShares(userId, itemIds),
    ]);
    return rows.map(({ agenda, item, counts, authorName }) => ({
        id: agenda.id,
        meetingItemId: agenda.meetingItemId,
        recordingItemId:
            agenda.recordingItemId &&
            visibleRecordingIds.has(agenda.recordingItemId)
                ? agenda.recordingItemId
                : null,
        title: decryptText(item.title),
        start: agenda.plannedStart,
        end: agenda.plannedEnd,
        timeSet: agenda.timeSet,
        createdAt: agenda.createdAt,
        state: agenda.state,
        liveStartedAt: agenda.liveStartedAt,
        editors: [
            { id: agenda.userId, name: authorName },
            ...editors
                .filter(
                    (editor) =>
                        editor.agendaId === agenda.id &&
                        editor.id !== agenda.userId,
                )
                .map(({ id, name }) => ({ id, name })),
        ],
        calendarEventId: agenda.calendarEventId,
        calendarSeriesId: agenda.calendarSeriesId,
        author: { id: agenda.userId, name: authorName },
        own: agenda.userId === userId,
        recorded: !!agenda.recordingItemId,
        received: receipts.some(
            (share) => share.itemId === agenda.meetingItemId,
        ),
        folders: [
            ...new Map(
                [...folders, ...filings]
                    .filter((folder) => folder.itemId === agenda.meetingItemId)
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .flatMap((folder) => {
                        const visible = navigation.project(folder);
                        return visible ? [[visible.id, visible] as const] : [];
                    }),
            ).values(),
        ],
        counts,
        version: agenda.version,
    }));
}

function buildPointTree<T extends { id: string; parentId: string | null }>(
    points: T[],
    parentId: string | null = null,
): (T & { children: ReturnType<typeof buildPointTree<T>> })[] {
    return points
        .filter((point) => point.parentId === parentId)
        .map((point) => ({
            ...point,
            children: buildPointTree(points, point.id),
        }));
}

/** Meeting detail; unchanged polls avoid loading tasks, points and Google. */
export async function getMeeting(
    userId: string,
    id: string,
    since?: number | string,
    webContext = false,
) {
    const access = await requireMeetingAccess(userId, id);
    let { agenda } = access;
    const { item } = access;
    const presence = await agendaRecordingBy(userId, agenda.id);
    const [suggestionJob] = await db
        .select({ status: asyncJobs.status, errorCode: asyncJobs.errorCode })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.subjectId, agenda.id),
                eq(asyncJobs.kind, "agenda.suggestions"),
            ),
        )
        .orderBy(
            sql`case when ${asyncJobs.status} in ('pending', 'processing') then 0 else 1 end`,
            desc(asyncJobs.createdAt),
            desc(asyncJobs.id),
        )
        .limit(1);
    const job = {
        state:
            suggestionJob?.status === "pending"
                ? ("queued" as const)
                : suggestionJob?.status === "processing"
                  ? ("running" as const)
                  : suggestionJob?.status === "failed"
                    ? ("failed" as const)
                    : null,
        ...(suggestionJob?.status === "failed" && suggestionJob.errorCode
            ? { errorCode: suggestionJob.errorCode }
            : {}),
    };
    const cursor = `${agenda.version}:${agenda.recordingItemId ? (access.recordingVisible ? "visible" : "hidden") : "standalone"}:${job.state ?? "idle"}${presence.cursor}`;
    if (agenda.recordingItemId && since === cursor)
        return { unchanged: true as const, version: agenda.version, cursor };
    if (
        ((!presence.cursor && Number(since) === agenda.version) ||
            since === cursor) &&
        !agenda.recordingItemId &&
        (!agenda.calendarEventId ||
            (agenda.calendarRefreshedAt &&
                agenda.calendarRefreshedAt.getTime() > Date.now() - 10 * 60000))
    ) {
        const [changedTask] = await db
            .select({ id: agendaTasks.taskId })
            .from(agendaTasks)
            .innerJoin(
                recordingTasks,
                eq(recordingTasks.id, agendaTasks.taskId),
            )
            .where(
                and(
                    eq(agendaTasks.agendaId, agenda.id),
                    eq(agendaTasks.userId, agenda.userId),
                    sql`${recordingTasks.updatedAt} > ${agenda.updatedAt.toISOString()}::timestamp`,
                ),
            )
            .limit(1);
        if (!changedTask)
            return {
                unchanged: true as const,
                version: agenda.version,
                cursor,
            };
        const [refreshed] = await db
            .update(meetingAgendas)
            .set({
                version: sql`${meetingAgendas.version} + 1`,
                updatedAt: new Date(),
            })
            .where(whereAgenda(agenda))
            .returning();
        agenda = refreshed;
        await publishAgendaEventInTx(db, agenda.id, String(agenda.version));
    }
    const [
        points,
        links,
        suggestions,
        folders,
        viewer,
        event,
        navigation,
        receipts,
        filings,
        receivedFolders,
        originalItems,
    ] = await Promise.all([
        db
            .select()
            .from(agendaPoints)
            .where(pointWhere(agenda))
            .orderBy(asc(agendaPoints.position), asc(agendaPoints.id)),
        db
            .select({
                ...getTableColumns(agendaTasks),
                statusChangedByUserId: recordingTasks.statusChangedByUserId,
            })
            .from(agendaTasks)
            .innerJoin(
                recordingTasks,
                eq(recordingTasks.id, agendaTasks.taskId),
            )
            .where(
                and(
                    eq(agendaTasks.agendaId, agenda.id),
                    eq(agendaTasks.userId, agenda.userId),
                ),
            )
            .orderBy(asc(agendaTasks.position), asc(agendaTasks.taskId)),
        db
            .select()
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.agendaId, agenda.id),
                    eq(agendaSuggestions.userId, agenda.userId),
                ),
            )
            .orderBy(asc(agendaSuggestions.createdAt)),
        agenda.meetingItemId
            ? meetingFolders(db, agenda.meetingItemId, agenda.userId)
            : [],
        taskViewerById(userId).then((value) => ({
            ...value,
            includeReceived: true,
        })),
        readMeetingCalendarSnapshot(agenda),
        meetingFolderNavigation(userId, access.viewer.orgUserId),
        receivedMeetingShares(
            userId,
            agenda.meetingItemId ? [agenda.meetingItemId] : [],
        ),
        receivedMeetingFilings(
            userId,
            agenda.meetingItemId ? [agenda.meetingItemId] : [],
        ),
        agenda.userId !== userId
            ? listVisibleItemFolders(
                  userId,
                  agenda.meetingItemId ? [agenda.meetingItemId] : [],
              )
            : [],
        agenda.meetingItemId && agenda.meetingItemId !== item.id
            ? db
                  .select({ title: chatterItems.title })
                  .from(chatterItems)
                  .where(
                      and(
                          eq(chatterItems.id, agenda.meetingItemId),
                          eq(chatterItems.userId, agenda.userId),
                      ),
                  )
            : [],
    ]);
    const suggestionTaskIds = [
        ...new Set(
            suggestions.flatMap(
                (suggestion) => suggestion.sources?.taskIds ?? [],
            ),
        ),
    ];
    const sourceItemIds = [
        ...new Set([
            ...suggestions.flatMap(
                (suggestion) => suggestion.sources?.itemIds ?? [],
            ),
            ...[agenda.taskSourceItemId, agenda.snapshotSourceItemId].filter(
                (id): id is string => id !== null,
            ),
        ]),
    ];
    const [sourceRows, taskRows] = await Promise.all([
        sourceItemIds.length
            ? db
                  .select({
                      id: chatterItems.id,
                      title: chatterItems.title,
                      occurredAt: chatterItems.occurredAt,
                  })
                  .from(chatterItems)
                  .where(
                      and(
                          inArray(chatterItems.id, sourceItemIds),
                          meetingVisibility(userId, access.viewer.orgUserId),
                      ),
                  )
            : [],
        getVisibleTasks(viewer, [
            ...new Set([
                ...links.map((link) => link.taskId),
                ...suggestionTaskIds,
            ]),
        ]),
    ]);
    const visibleItems = new Map(sourceRows.map((row) => [row.id, row]));
    const visibleTasks = new Map(taskRows.map((task) => [task.id, task]));
    const visibleSuggestions = suggestions.filter((suggestion) =>
        hasVisibleAgendaSources(suggestion.sources, visibleItems, visibleTasks),
    );
    const visibleSuggestionTaskIds = new Set(
        visibleSuggestions
            .filter((suggestion) => suggestion.state === "open")
            .flatMap((suggestion) => suggestion.sources?.taskIds ?? []),
    );
    const taskSource = agenda.snapshotSourceItemId
        ? visibleItems.get(agenda.snapshotSourceItemId)
        : undefined;
    const tasks = links.flatMap((link) => {
        const task = visibleTasks.get(link.taskId);
        return task
            ? [
                  {
                      ...task,
                      removedAt: link.removedAt,
                      agendaNote: link.note ? decryptText(link.note) : null,
                      agendaOrigin: link.origin,
                      agendaVersion: link.version,
                      agendaUpdatedAt: link.updatedAt,
                      agendaUpdatedByUserId: link.updatedByUserId,
                      statusChangedByUserId: link.statusChangedByUserId,
                      position: link.position,
                  },
              ]
            : [];
    });
    const authorIds = [
        ...new Set([
            agenda.userId,
            ...points.flatMap((point) =>
                [
                    point.authorUserId,
                    point.updatedByUserId,
                    point.discussedByUserId,
                ].filter((id): id is string => id !== null),
            ),
            ...links
                .filter((link) => visibleTasks.has(link.taskId))
                .flatMap((link) =>
                    link.updatedByUserId ? [link.updatedByUserId] : [],
                ),
            ...tasks.flatMap((task) =>
                task.statusChangedByUserId ? [task.statusChangedByUserId] : [],
            ),
        ]),
    ];
    const authors = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, authorIds));
    let canExportCalendar: boolean | null = event?.organizer?.self === true;
    if (agenda.calendarEventId && agenda.userId !== userId) {
        const connection = await getGoogleConnectionStatus(userId);
        canExportCalendar =
            connection?.status === "active" &&
            connection.email &&
            event?.organizer?.email
                ? connection.email.trim().toLowerCase() ===
                  event.organizer.email.trim().toLowerCase()
                : null;
    }
    const standaloneItemId = !agenda.recordingItemId
        ? agenda.meetingItemId
        : null;
    const [invitees, folderRecordings, attachmentAudience] = await Promise.all([
        event ? meetingInvitees(userId, event.attendees) : [],
        webContext && folders.length
            ? db
                  .selectDistinct({ id: chatterItems.id })
                  .from(recordingFolderAssignments)
                  .innerJoin(
                      chatterItems,
                      eq(chatterItems.id, recordingFolderAssignments.itemId),
                  )
                  .where(
                      and(
                          inArray(
                              recordingFolderAssignments.folderId,
                              folders.map((folder) => folder.id),
                          ),
                          eq(chatterItems.kind, "audio"),
                          meetingVisibility(userId, access.viewer.orgUserId),
                      ),
                  )
            : [],
        access.permissions.edit && standaloneItemId
            ? retryOnDeadlock(() =>
                  db.transaction(
                      async (tx) =>
                          (
                              await meetingAttachmentAudienceInTx(tx, {
                                  itemId: standaloneItemId,
                                  ownerUserId: agenda.userId,
                                  actorUserId: userId,
                                  orgUserId: access.viewer.orgUserId,
                                  folderIds: folders.map((folder) => folder.id),
                              })
                          ).disclosure,
                  ),
              )
            : undefined,
    ]);
    const tree = points.map((point) => ({
        ...readPoint(point),
        summaryOutcome:
            agenda.recordingItemId && !access.recordingVisible
                ? null
                : point.summaryOutcome,
    }));
    const {
        calendarSnapshot: _snapshot,
        calendarRefreshedAt: _refreshedAt,
        outcomeUnplanned: _unplanned,
        outcomeSummaryId: _summaryId,
        ...publicAgenda
    } = agenda;
    return {
        unchanged: false as const,
        ...publicAgenda,
        recordingItemId: access.recordingVisible
            ? agenda.recordingItemId
            : null,
        taskSourceItemId:
            agenda.recordingItemId && !access.recordingVisible
                ? null
                : agenda.taskSourceItemId &&
                    visibleItems.has(agenda.taskSourceItemId)
                  ? agenda.taskSourceItemId
                  : null,
        snapshotSourceItemId:
            agenda.recordingItemId && !access.recordingVisible
                ? null
                : agenda.snapshotSourceItemId &&
                    visibleItems.has(agenda.snapshotSourceItemId)
                  ? agenda.snapshotSourceItemId
                  : null,
        cursor: `${agenda.version}:${agenda.recordingItemId ? (access.recordingVisible ? "visible" : "hidden") : "standalone"}:${job.state ?? "idle"}${presence.cursor}`,
        recordingBy: presence.recordingBy,
        attachedRecording: agenda.recordingItemId
            ? { visible: access.recordingVisible }
            : null,
        title: decryptText(item.title),
        agendaTitle: decryptText(originalItems[0]?.title ?? item.title),
        permissions: access.permissions,
        authors,
        canExportCalendar,
        redirectTo: await meetingRecordingRedirect(userId, access),
        shared: access.shared,
        receivedFolders,
        receivedShare: receipts[0] ?? null,
        folders: [
            ...new Map(
                [...folders, ...filings].flatMap((folder) => {
                    const visible = navigation.project(folder);
                    return visible ? [[visible.id, visible] as const] : [];
                }),
            ).values(),
        ],
        ...(attachmentAudience ? { attachmentAudience } : {}),
        invitees,
        ...(webContext
            ? {
                  folderRecordingIds: folderRecordings.map(
                      (recording) => recording.id,
                  ),
                  suggestionTasks: [...visibleTasks.values()]
                      .filter((task) => visibleSuggestionTaskIds.has(task.id))
                      .map(({ id, text }) => ({ id, text })),
              }
            : {}),
        taskSource:
            taskSource && (!agenda.recordingItemId || access.recordingVisible)
                ? {
                      ...taskSource,
                      title: decryptText(taskSource.title),
                      automatic: agenda.taskSourceItemId === null,
                  }
                : null,
        points: tree,
        textProtocol: 1,
        pointTree: buildPointTree(tree),
        tasks,
        taskGroups: groupAgendaTasks(
            tasks.filter((task) => !task.removedAt),
            invitees,
        ),
        suggestions: visibleSuggestions.map((suggestion) => ({
            ...suggestion,
            text: decryptText(suggestion.text),
        })),
        aiSuggestions: {
            ...(agenda.recordingItemId
                ? { available: false, reason: null }
                : await agendaSuggestionsAvailability(userId, agenda.id)),
            job,
        },
        ...(agenda.recordingItemId && !access.recordingVisible
            ? {}
            : {
                  outcomeSummaryId: agenda.outcomeSummaryId,
                  outcomeUnplanned:
                      decryptJsonField<string[]>(agenda.outcomeUnplanned) ?? [],
              }),
        calendar: event
            ? {
                  organizer: event.organizer
                      ? {
                            self: event.organizer.self,
                            name: event.organizer.name,
                        }
                      : undefined,
                  htmlLink: event.htmlLink,
                  attendeeCount: event.attendees.length,
                  externalInviteeCount: event.organizer?.email
                      ? event.attendees.filter(
                            (attendee) =>
                                attendee.email &&
                                attendee.email.split("@")[1]?.toLowerCase() !==
                                    event.organizer?.email
                                        ?.split("@")[1]
                                        ?.toLowerCase(),
                        ).length
                      : null,
              }
            : null,
    };
}

/** Change meeting metadata or resnapshot its task source under the agenda lock. */
export async function patchMeeting(
    userId: string,
    id: string,
    raw: z.input<typeof patchMeetingInput>,
) {
    const input = patchMeetingInput.parse(raw);
    const event = input.calendarEventId
        ? await getCalendarEvent(userId, input.calendarEventId)
        : null;
    const tasksViewer = {
        ...(await taskViewerById(userId)),
        includeReceived: true,
    };
    await editMeeting(userId, id, "manage", async (tx, access) => {
        const agenda = access.agenda;
        const current = {
            title: decryptText(access.item.title),
            start: agenda.plannedStart?.toISOString() ?? null,
            end: agenda.plannedEnd?.toISOString() ?? null,
            calendarEventId: agenda.calendarEventId,
            taskSourceItemId: agenda.taskSourceItemId,
        };
        const metadataFields = [
            "title",
            "start",
            "end",
            "calendarEventId",
            "taskSourceItemId",
        ] as const;
        const fields = metadataFields.filter(
            (field) => input[field] !== undefined,
        );
        if (fields.length === 0 && input.state === agenda.state) return false;
        const conflict = input.previous
            ? fields.some((field) => {
                  const previous = input.previous?.[field];
                  return (field === "start" || field === "end") && previous
                      ? new Date(previous).toISOString() !== current[field]
                      : previous !== current[field];
              })
            : fields.length > 0 &&
              input.version !== undefined &&
              input.version !== agenda.version;
        if (conflict)
            throw new AppError(ErrorCode.CONFLICT, "Meeting changed", 409, {
                version: agenda.version,
            });
        if (event) {
            await lockMeetingEvent(tx, event.id);
            const existing = await listMeetingRows(
                userId,
                access.viewer.orgUserId,
                {
                    calendarEventId: event.id,
                    includePast: true,
                    includeAbsorbed: true,
                },
                tx,
            );
            if (existing.some((entry) => entry.agenda.id !== agenda.id))
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "A visible agenda already exists for this event",
                    409,
                    { agendaId: existing[0].agenda.id },
                );
        }
        const start = event
            ? new Date(event.start)
            : input.start !== undefined
              ? input.start
                  ? new Date(input.start)
                  : null
              : agenda.plannedStart;
        const end = event
            ? new Date(event.end)
            : input.end !== undefined
              ? input.end
                  ? new Date(input.end)
                  : null
              : agenda.plannedEnd;
        if (end && (!start || end <= start))
            invalid("Meeting end must follow its start");
        const [updated] = await tx
            .update(meetingAgendas)
            .set({
                plannedStart: start,
                plannedEnd: end,
                timeSet: start !== null,
                ...(input.calendarEventId !== undefined
                    ? {
                          calendarEventId: event?.id ?? null,
                          calendarSeriesId: event?.recurringEventId ?? null,
                          calendarSnapshot: calendarSnapshotWithEditors(
                              event ? encryptCalendarSnapshot(event) : null,
                          ),
                          calendarRefreshedAt: event ? new Date() : null,
                      }
                    : {}),
                ...(input.taskSourceItemId !== undefined
                    ? { taskSourceItemId: input.taskSourceItemId }
                    : {}),
                ...(input.state
                    ? {
                          state: input.state,
                          ...(input.state === "live"
                              ? {
                                    liveStartedAt:
                                        agenda.liveStartedAt ?? new Date(),
                                    liveEndedAt: null,
                                }
                              : input.state === "held"
                                ? {
                                      liveEndedAt:
                                          agenda.liveEndedAt ?? new Date(),
                                  }
                                : {}),
                      }
                    : {}),
            })
            .where(whereAgenda(agenda))
            .returning();
        if (agenda.meetingItemId)
            await tx
                .update(chatterItems)
                .set({
                    ...(input.title || event
                        ? {
                              title: encryptText(
                                  input.title ?? event?.title ?? "Meeting",
                              ),
                              titleEditedAt: new Date(),
                          }
                        : {}),
                    occurredAt: start ?? agenda.createdAt,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(chatterItems.id, agenda.meetingItemId),
                        eq(chatterItems.userId, agenda.userId),
                    ),
                );
        if (
            (input.taskSourceItemId !== undefined &&
                input.taskSourceItemId !== agenda.taskSourceItemId) ||
            (input.calendarEventId !== undefined &&
                input.calendarEventId !== agenda.calendarEventId)
        ) {
            const folders = agenda.meetingItemId
                ? await meetingFolders(tx, agenda.meetingItemId, agenda.userId)
                : [];
            await snapshotTasks(
                tx,
                updated,
                folders.map((folder) => folder.id),
                tasksViewer,
            );
        }
    });
    return getMeeting(userId, id);
}

/** Unfile a standalone agenda through the ordinary item filing permissions and locks. */
export async function removeMeetingFromFolder(
    userId: string,
    id: string,
    folderId: string,
) {
    const { agenda } = await requireMeetingAccess(userId, id, "edit");
    if (!agenda.meetingItemId)
        throw new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404);
    await removeRecordingFromFolder({
        userId,
        recordingId: agenda.meetingItemId,
        folderId,
        withdraw: true,
    });
    if (agenda.userId === userId)
        await refreshMeetingFolderContext(userId, agenda.meetingItemId);
}

/** Delete a standalone meeting and its agenda, leaving real task changes intact. */
export async function deleteMeeting(userId: string, id: string) {
    await editMeeting(userId, id, "manage", async (tx, { agenda }) => {
        await tx.delete(meetingAgendas).where(whereAgenda(agenda));
        if (agenda.meetingItemId)
            await tx
                .delete(chatterItems)
                .where(
                    and(
                        eq(chatterItems.id, agenda.meetingItemId),
                        eq(chatterItems.userId, agenda.userId),
                    ),
                );
    });
}

/** Add one point, preserving author attribution and checking the whole resulting tree. */
export async function addPoint(
    userId: string,
    id: string,
    raw: z.input<typeof createPointInput>,
) {
    const input = createPointInput.parse(raw);
    return editMeeting(
        userId,
        id,
        "edit",
        async (tx, { agenda }) => {
            const points = await tx
                .select()
                .from(agendaPoints)
                .where(pointWhere(agenda));
            const next = {
                id: nanoid(),
                parentId: input.parentId ?? null,
                position: input.position ?? points.length,
            };
            validatePointTree([...points, next]);
            if (input.position !== undefined)
                await tx
                    .update(agendaPoints)
                    .set({ position: sql`${agendaPoints.position} + 1` })
                    .where(
                        and(
                            pointWhere(agenda),
                            sql`${agendaPoints.position} >= ${input.position}`,
                        ),
                    );
            const [point] = await tx
                .insert(agendaPoints)
                .values({
                    ...next,
                    agendaId: agenda.id,
                    userId: agenda.userId,
                    text: encryptText(input.text),
                    authorUserId: userId,
                    updatedByUserId: userId,
                    origin: input.origin ?? "manual",
                })
                .returning();
            return readPoint(point);
        },
        true,
    );
}

/** Update or delete a point with optimistic concurrency and per-author structural permissions. */
export async function changePoint(
    userId: string,
    id: string,
    pointId: string,
    raw: z.input<typeof patchPointInput>,
    remove = false,
) {
    const input = patchPointInput.parse(raw);
    return editMeeting(
        userId,
        id,
        "edit",
        async (tx, access) => {
            const { agenda } = access;
            const points = await tx
                .select()
                .from(agendaPoints)
                .where(pointWhere(agenda));
            const point = points.find((entry) => entry.id === pointId);
            if (!point)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Agenda point not found",
                    404,
                );
            if (point.version !== input.version)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "Agenda point changed",
                    409,
                    {
                        point: readPoint(point),
                    },
                );
            const structural =
                remove ||
                input.text !== undefined ||
                input.parentId !== undefined ||
                input.position !== undefined;
            if (
                structural &&
                point.authorUserId !== userId &&
                !access.permissions.manage
            )
                throw new AppError(
                    ErrorCode.FORBIDDEN,
                    "You may edit only your own points",
                    403,
                );
            if (remove) {
                const descendants = new Set([point.id]);
                for (let depth = 0; depth < 3; depth++)
                    for (const entry of points)
                        if (entry.parentId && descendants.has(entry.parentId))
                            descendants.add(entry.id);
                if (
                    !access.permissions.manage &&
                    points.some(
                        (entry) =>
                            descendants.has(entry.id) &&
                            entry.authorUserId !== userId,
                    )
                )
                    throw new AppError(
                        ErrorCode.FORBIDDEN,
                        "This point contains another author's points",
                        403,
                    );
                if (input.mergeUp)
                    await tx
                        .update(agendaPoints)
                        .set({
                            parentId: point.parentId,
                            version: sql`${agendaPoints.version} + 1`,
                            updatedAt: new Date(),
                        })
                        .where(
                            and(
                                pointWhere(agenda),
                                eq(agendaPoints.parentId, point.id),
                            ),
                        );
                await deletePointTextDocsInTx(
                    tx,
                    agenda,
                    input.mergeUp ? [point.id] : [...descendants],
                );
                await tx
                    .delete(agendaPoints)
                    .where(
                        and(pointWhere(agenda), eq(agendaPoints.id, pointId)),
                    );
                return null;
            }
            validatePointTree(
                points.map((entry) =>
                    entry.id === pointId
                        ? {
                              ...entry,
                              parentId:
                                  input.parentId !== undefined
                                      ? input.parentId
                                      : entry.parentId,
                          }
                        : entry,
                ),
            );
            if (input.position !== undefined)
                await tx
                    .update(agendaPoints)
                    .set({ position: sql`${agendaPoints.position} + 1` })
                    .where(
                        and(
                            pointWhere(agenda),
                            ne(agendaPoints.id, pointId),
                            sql`${agendaPoints.position} >= ${input.position}`,
                        ),
                    );
            if (input.text !== undefined)
                await replaceAgendaTextInTx(
                    tx,
                    agenda,
                    `point:${point.id}:text`,
                    decryptText(point.text),
                    input.text,
                    userId,
                );
            if (input.note !== undefined)
                await replaceAgendaTextInTx(
                    tx,
                    agenda,
                    `point:${point.id}:note`,
                    decryptText(point.note) ?? "",
                    input.note ?? "",
                    userId,
                );
            const [updated] = await tx
                .update(agendaPoints)
                .set({
                    ...(input.text !== undefined
                        ? { text: encryptText(input.text) }
                        : {}),
                    ...(input.parentId !== undefined
                        ? { parentId: input.parentId }
                        : {}),
                    ...(input.position !== undefined
                        ? { position: input.position }
                        : {}),
                    ...(input.discussed !== undefined
                        ? {
                              discussedAt: input.discussed ? new Date() : null,
                              discussedByUserId: input.discussed
                                  ? userId
                                  : null,
                          }
                        : {}),
                    ...(input.note !== undefined
                        ? {
                              note: input.note ? encryptText(input.note) : null,
                              noteAt: new Date(),
                          }
                        : {}),
                    version: point.version + 1,
                    updatedByUserId: userId,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        pointWhere(agenda),
                        eq(agendaPoints.id, pointId),
                        eq(agendaPoints.version, input.version),
                    ),
                )
                .returning();
            return readPoint(updated);
        },
        true,
    );
}

/** Add an explicitly chosen older visible task to the frozen review list. */
export async function addAgendaTask(
    userId: string,
    id: string,
    taskId: string,
) {
    return addAgendaTasks(userId, id, [taskId]);
}

/** Add older tasks atomically in selection order under the agenda lock. */
export async function addAgendaTasks(
    userId: string,
    id: string,
    rawTaskIds: readonly string[],
) {
    const taskIds = agendaTaskIdsInput.parse(rawTaskIds);
    const viewer = { ...(await taskViewerById(userId)), includeReceived: true };
    await editMeeting(userId, id, "edit", async (tx, { agenda }) => {
        const folders = agenda.meetingItemId
            ? await meetingFolders(tx, agenda.meetingItemId, agenda.userId)
            : [];
        const candidates = folders.length
            ? await tx
                  .select({ id: recordingTasks.id })
                  .from(recordingTasks)
                  .leftJoin(
                      chatterItems,
                      eq(chatterItems.id, recordingTasks.itemId),
                  )
                  .where(
                      and(
                          inArray(recordingTasks.id, taskIds),
                          olderTaskCondition(
                              viewer,
                              folders.map((folder) => folder.id),
                          ),
                      ),
                  )
            : [];
        const links = await tx
            .select()
            .from(agendaTasks)
            .where(
                and(
                    eq(agendaTasks.agendaId, agenda.id),
                    eq(agendaTasks.userId, agenda.userId),
                ),
            );
        const eligible = new Set(candidates.map((task) => task.id));
        const current = new Set(
            links.filter((link) => !link.removedAt).map((link) => link.taskId),
        );
        const refusedTaskIds = taskIds.filter(
            (taskId) => !eligible.has(taskId),
        );
        if (refusedTaskIds.length)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Open task in this folder not found",
                404,
                { refusedTaskIds },
            );
        const addedTaskIds = taskIds.filter((taskId) => !current.has(taskId));
        if (!addedTaskIds.length) return false;
        const lastPosition = Math.max(
            -1,
            ...links.map((link) => link.position),
        );
        const firstPosition = Math.max(
            lastPosition + 1,
            OLDER_TASK_POSITION_BASE,
        );
        await tx
            .insert(agendaTasks)
            .values(
                addedTaskIds.map((taskId, index) => ({
                    agendaId: agenda.id,
                    userId: agenda.userId,
                    taskId,
                    origin: "older" as const,
                    position: firstPosition + index,
                })),
            )
            .onConflictDoUpdate({
                target: [agendaTasks.agendaId, agendaTasks.taskId],
                set: { removedAt: null, position: sql`excluded.position` },
                setWhere: eq(agendaTasks.userId, agenda.userId),
            });
    });
}

/** Update the agenda's task note or hide/restore its snapshot membership. */
export async function changeAgendaTask(
    userId: string,
    id: string,
    taskId: string,
    change: { note?: string | null; removed?: boolean },
) {
    const viewer = { ...(await taskViewerById(userId)), includeReceived: true };
    await editMeeting(userId, id, "edit", async (tx, { agenda }) => {
        const [task] = await tx
            .select({ id: recordingTasks.id })
            .from(recordingTasks)
            .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
            .where(
                and(
                    eq(recordingTasks.id, taskId),
                    taskVisible(viewer, ANY_TASK_ITEM, true),
                ),
            )
            .limit(1);
        if (!task)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Agenda task not found",
                404,
            );
        if (change.note !== undefined) {
            const [link] = await tx
                .select({ note: agendaTasks.note })
                .from(agendaTasks)
                .where(
                    and(
                        eq(agendaTasks.agendaId, agenda.id),
                        eq(agendaTasks.userId, agenda.userId),
                        eq(agendaTasks.taskId, taskId),
                    ),
                );
            if (!link)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Agenda task not found",
                    404,
                );
            await replaceAgendaTextInTx(
                tx,
                agenda,
                `task:${taskId}:note`,
                decryptText(link.note) ?? "",
                change.note ?? "",
                userId,
            );
        }
        const [row] = await tx
            .update(agendaTasks)
            .set({
                ...(change.note !== undefined
                    ? { note: change.note ? encryptText(change.note) : null }
                    : {}),
                ...(change.removed !== undefined
                    ? { removedAt: change.removed ? new Date() : null }
                    : {}),
                version: sql`${agendaTasks.version} + 1`,
                updatedAt: new Date(),
                updatedByUserId: userId,
            })
            .where(
                and(
                    eq(agendaTasks.agendaId, agenda.id),
                    eq(agendaTasks.userId, agenda.userId),
                    eq(agendaTasks.taskId, taskId),
                ),
            )
            .returning();
        if (!row)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Agenda task not found",
                404,
            );
    });
}

/** Accept or dismiss a suggestion atomically, creating at most one point. */
export async function decideSuggestion(
    userId: string,
    id: string,
    suggestionId: string,
    state: "added" | "dismissed",
) {
    await editMeeting(userId, id, "edit", async (tx, { agenda }) => {
        const [suggestion] = await tx
            .select()
            .from(agendaSuggestions)
            .where(
                and(
                    eq(agendaSuggestions.id, suggestionId),
                    eq(agendaSuggestions.agendaId, agenda.id),
                    eq(agendaSuggestions.userId, agenda.userId),
                ),
            );
        if (!suggestion)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Suggestion not found",
                404,
            );
        if (suggestion.state !== "open") return;
        if (state === "added") {
            const points = await tx
                .select()
                .from(agendaPoints)
                .where(pointWhere(agenda));
            const point = {
                id: nanoid(),
                parentId: points.some(
                    (entry) => entry.id === suggestion.parentPointId,
                )
                    ? suggestion.parentPointId
                    : null,
                position: points.length,
            };
            try {
                validatePointTree([...points, point]);
            } catch {
                point.parentId = null;
            }
            await tx.insert(agendaPoints).values({
                ...point,
                userId: agenda.userId,
                agendaId: agenda.id,
                text: suggestion.text,
                sources: suggestion.sources,
                authorUserId: userId,
                updatedByUserId: userId,
                origin: suggestion.kind,
                originPointId: suggestion.originPointId,
            });
        }
        await tx
            .update(agendaSuggestions)
            .set({ state, updatedAt: new Date() })
            .where(
                and(
                    eq(agendaSuggestions.id, suggestionId),
                    eq(agendaSuggestions.userId, agenda.userId),
                    eq(agendaSuggestions.agendaId, agenda.id),
                ),
            );
    });
}

function olderTaskCondition(viewer: TaskViewer, folderIds: string[]) {
    return and(
        eq(recordingTasks.status, "open"),
        ne(recordingTasks.source, "personal"),
        isNull(chatterItems.deletedAt),
        or(
            isNull(chatterItems.id),
            inArray(chatterItems.kind, ["audio", "mail"]),
        ),
        or(
            sql`exists (select 1 from ${recordingFolderAssignments} where ${recordingFolderAssignments.itemId} = ${recordingTasks.itemId} and ${inArray(recordingFolderAssignments.folderId, folderIds)})`,
            sql`exists (select 1 from ${taskMentions} inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.itemId} = ${taskMentions.itemId} where ${taskMentions.taskId} = ${recordingTasks.id} and ${taskMentions.matchDecision} in ('home', 'accepted', 'kept_new') and ${inArray(recordingFolderAssignments.folderId, folderIds)})`,
        ),
        taskVisible(viewer, ANY_TASK_ITEM, true),
    );
}

/** Open tasks in the meeting's folder, optionally limited to its invitees; never pre-added. */
export async function olderTasks(
    userId: string,
    id: string,
    scope: "invited" | "all",
) {
    const detail = await getMeeting(userId, id);
    if (detail.unchanged) return [];
    const folders = detail.meetingItemId
        ? await meetingFolders(db, detail.meetingItemId, detail.userId)
        : [];
    const folderIds = folders.map((folder) => folder.id);
    if (!folderIds.length) return [];
    const viewer = { ...(await taskViewerById(userId)), includeReceived: true };
    const rows = await db
        .select({ id: recordingTasks.id })
        .from(recordingTasks)
        .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
        .where(olderTaskCondition(viewer, folderIds))
        .limit(500);
    const current = new Set(
        detail.tasks.filter((task) => !task.removedAt).map((task) => task.id),
    );
    const names = new Set(
        detail.invitees.map((invitee) => invitee.name.toLocaleLowerCase()),
    );
    const tasks = await getVisibleTasks(
        viewer,
        [...new Set(rows.map((row) => row.id))].filter(
            (taskId) => !current.has(taskId),
        ),
    );
    return tasks.filter(
        (task) =>
            task &&
            (scope === "all" ||
                names.has(
                    (
                        task.assignee?.name ??
                        task.assigneeHint ??
                        ""
                    ).toLocaleLowerCase(),
                )),
    );
}

/** Resolve reminder paths in one batch, using the receiver's filing instead of private owner ancestors. */
export async function meetingFolderPaths(userId: string) {
    const viewer = await meetingViewer(userId);
    const navigation = await meetingFolderNavigation(userId, viewer.orgUserId);
    return (
        folders: readonly {
            id: string;
            name: string;
            parentId: string | null;
        }[],
    ) => navigation.path(folders);
}

/** Include authors, direct receivers, point editors and stored Calendar invitees in recorder reminders. */
export async function reminderMeetings(
    userId: string,
    input: Parameters<typeof listMeetingRows>[2],
) {
    const viewer = await meetingViewer(userId);
    const [rows, connection] = await Promise.all([
        listMeetingRows(userId, viewer.orgUserId, input),
        getGoogleConnectionStatus(userId),
    ]);
    const email =
        connection?.status === "active"
            ? connection.email?.trim().toLowerCase()
            : null;
    const receipts = await receivedMeetingShares(
        userId,
        rows.flatMap(({ agenda }) =>
            agenda.meetingItemId ? [agenda.meetingItemId] : [],
        ),
    );
    const eligible = new Set<string>(
        rows
            .filter(({ agenda }) =>
                receipts.some((share) => share.itemId === agenda.meetingItemId),
            )
            .map(({ agenda }) => agenda.id),
    );
    for (const { agenda } of rows) {
        const snapshot = decryptJsonField<{ attendees?: { email?: string }[] }>(
            agenda.calendarSnapshot,
        );
        const metadata = agenda.calendarSnapshot as {
            editorUserIds?: string[];
        } | null;
        if (
            agenda.userId === userId ||
            metadata?.editorUserIds?.includes(userId) ||
            (email &&
                snapshot?.attendees?.some(
                    (attendee) =>
                        attendee.email?.trim().toLowerCase() === email,
                ))
        )
            eligible.add(agenda.id);
    }
    if (rows.length) {
        const edited = await db
            .select({ agendaId: agendaPoints.agendaId })
            .from(agendaPoints)
            .where(
                and(
                    or(
                        ...rows.map(({ agenda }) =>
                            and(
                                eq(agendaPoints.agendaId, agenda.id),
                                eq(agendaPoints.userId, agenda.userId),
                            ),
                        ),
                    ),
                    or(
                        eq(agendaPoints.authorUserId, userId),
                        eq(agendaPoints.discussedByUserId, userId),
                    ),
                ),
            );
        for (const row of edited) eligible.add(row.agendaId);
    }
    return (await listMeetings(userId, input)).filter(
        (row) => !row.recorded && eligible.has(row.id),
    );
}
