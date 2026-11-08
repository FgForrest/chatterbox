import { and, eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "@/db";
import { bumpAgendaInTx } from "@/db/queries/agenda-events";
import type { MeetingTx } from "@/db/queries/meetings";
import { ANY_TASK_ITEM, taskVisible } from "@/db/queries/task-visibility";
import {
    agendaPoints,
    agendaTasks,
    agendaTextDocs,
    chatterItems,
    meetingAgendas,
    recordingTasks,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { meetingViewer, requireMeetingAccess } from "@/lib/meetings/access";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
    createAgendaTextDoc,
    MAX_AGENDA_TEXT_STATE_BYTES,
    materializeAgendaText,
} from "@/lib/meetings/text-model";
import { taskViewerById } from "@/lib/tasks/access";

type Agenda = Pick<typeof meetingAgendas.$inferSelect, "id" | "userId">;

function invalid(): never {
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "Invalid agenda text update",
        400,
    );
}

/** Validate a field reference without permitting identifiers from a different agenda. */
export function parseAgendaTextField(value: string) {
    const match = /^(point|task):([^:]{1,255}):(text|note)$/.exec(value);
    if (!match || (match[1] === "task" && match[3] !== "note")) invalid();
    return {
        kind: match[1] as "point" | "task",
        id: match[2],
        column: match[3] as "text" | "note",
    };
}

function docWhere(agenda: Agenda, field: string) {
    return and(
        eq(agendaTextDocs.agendaId, agenda.id),
        eq(agendaTextDocs.userId, agenda.userId),
        eq(agendaTextDocs.field, field),
    );
}

async function readDocInTx(
    tx: MeetingTx,
    agenda: Agenda,
    field: string,
    plainText: string,
) {
    const [row] = await tx
        .select()
        .from(agendaTextDocs)
        .where(docWhere(agenda, field))
        .for("update");
    if (row) {
        const doc = new Y.Doc();
        doc.getText(AGENDA_TEXT_NAME);
        Y.applyUpdate(
            doc,
            agendaTextBytes(
                decryptText(row.state),
                MAX_AGENDA_TEXT_STATE_BYTES,
            ),
        );
        if (doc.getText(AGENDA_TEXT_NAME).toString() !== plainText) {
            const text = doc.getText(AGENDA_TEXT_NAME);
            doc.transact(() => {
                text.delete(0, text.length);
                text.insert(0, plainText);
            });
            await storeDocInTx(tx, agenda, field, doc, agenda.userId);
            return { doc, version: row.version + 1 };
        }
        return { doc, version: row.version };
    }
    const doc = createAgendaTextDoc(plainText);
    await tx.insert(agendaTextDocs).values({
        userId: agenda.userId,
        agendaId: agenda.id,
        field,
        state: encryptText(agendaTextBase64(Y.encodeStateAsUpdate(doc))),
    });
    return { doc, version: 0 };
}

async function storeDocInTx(
    tx: MeetingTx,
    agenda: Agenda,
    field: string,
    doc: Y.Doc,
    actorId: string,
) {
    const state = Y.encodeStateAsUpdate(doc);
    if (state.byteLength > MAX_AGENDA_TEXT_STATE_BYTES) invalid();
    await tx
        .update(agendaTextDocs)
        .set({
            state: encryptText(agendaTextBase64(state)),
            version: sql`${agendaTextDocs.version} + 1`,
            updatedAt: new Date(),
            updatedByUserId: actorId,
        })
        .where(docWhere(agenda, field));
}

/** Keep legacy plain PATCHes in the same document history; caller already holds the agenda lock. */
export async function replaceAgendaTextInTx(
    tx: MeetingTx,
    agenda: Agenda,
    field: string,
    previous: string,
    next: string,
    actorId: string,
) {
    const { doc } = await readDocInTx(tx, agenda, field, previous);
    try {
        const text = doc.getText(AGENDA_TEXT_NAME);
        doc.transact(() => {
            text.delete(0, text.length);
            text.insert(0, next);
        });
        await storeDocInTx(tx, agenda, field, doc, actorId);
    } finally {
        doc.destroy();
    }
}

/** Remove derivative text docs with the points, including cascading descendants. */
export async function deletePointTextDocsInTx(
    tx: MeetingTx,
    agenda: Agenda,
    pointIds: string[],
) {
    await tx.delete(agendaTextDocs).where(
        and(
            eq(agendaTextDocs.agendaId, agenda.id),
            eq(agendaTextDocs.userId, agenda.userId),
            inArray(
                agendaTextDocs.field,
                pointIds.flatMap((id) => [
                    `point:${id}:text`,
                    `point:${id}:note`,
                ]),
            ),
        ),
    );
}

async function withTextField<T>(
    userId: string,
    id: string,
    field: string,
    write: boolean,
    run: (
        tx: MeetingTx,
        agenda: Agenda,
        value: string,
        required: boolean,
        materializedVersion: number,
    ) => Promise<T>,
) {
    const ref = parseAgendaTextField(field);
    const [viewer, tasksViewer] = await Promise.all([
        meetingViewer(userId),
        ref.kind === "task"
            ? taskViewerById(userId).then((value) => ({
                  ...value,
                  includeReceived: true,
              }))
            : null,
    ]);
    return db.transaction(async (tx) => {
        const access = await requireMeetingAccess(
            userId,
            id,
            write ? "edit" : "view",
            { viewer, executor: tx, lock: true },
        );
        const { agenda } = access;
        if (ref.kind === "point") {
            const [point] = await tx
                .select()
                .from(agendaPoints)
                .where(
                    and(
                        eq(agendaPoints.agendaId, agenda.id),
                        eq(agendaPoints.userId, agenda.userId),
                        eq(agendaPoints.id, ref.id),
                    ),
                );
            if (!point)
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Agenda point not found",
                    404,
                );
            if (
                write &&
                ref.column === "text" &&
                point.authorUserId !== userId &&
                !access.permissions.manage
            )
                throw new AppError(
                    ErrorCode.FORBIDDEN,
                    "You may edit only your own points",
                    403,
                );
            return run(
                tx,
                agenda,
                decryptText(point[ref.column]) ?? "",
                ref.column === "text",
                point.version,
            );
        }
        if (!tasksViewer) invalid();
        const [link] = await tx
            .select({ note: agendaTasks.note, version: agendaTasks.version })
            .from(agendaTasks)
            .innerJoin(
                recordingTasks,
                eq(recordingTasks.id, agendaTasks.taskId),
            )
            .leftJoin(chatterItems, eq(chatterItems.id, recordingTasks.itemId))
            .where(
                and(
                    eq(agendaTasks.agendaId, agenda.id),
                    eq(agendaTasks.userId, agenda.userId),
                    eq(agendaTasks.taskId, ref.id),
                    taskVisible(tasksViewer, ANY_TASK_ITEM, true),
                ),
            );
        if (!link)
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Agenda task not found",
                404,
            );
        return run(
            tx,
            agenda,
            decryptText(link.note) ?? "",
            false,
            link.version,
        );
    });
}

/** Fetch the authoritative seed before any local editing, including simultaneous first editors. */
export async function getAgendaText(userId: string, id: string, field: string) {
    return withTextField(
        userId,
        id,
        field,
        false,
        async (tx, agenda, value, _required, materializedVersion) => {
            const { doc, version } = await readDocInTx(
                tx,
                agenda,
                field,
                value,
            );
            try {
                return {
                    field,
                    update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
                    stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
                    version,
                    materializedVersion,
                };
            } finally {
                doc.destroy();
            }
        },
    );
}

/** Merge one bounded update, materialize encrypted text and advance the invalidation cursor atomically. */
export async function updateAgendaText(
    userId: string,
    id: string,
    input: { field: string; update: string; stateVector?: string },
) {
    let update: Uint8Array;
    let stateVector: Uint8Array | undefined;
    try {
        update = agendaTextBytes(input.update);
        stateVector = input.stateVector
            ? agendaTextBytes(input.stateVector, 8192)
            : undefined;
        if (stateVector) Y.decodeStateVector(stateVector);
    } catch {
        invalid();
    }
    return withTextField(
        userId,
        id,
        input.field,
        true,
        async (tx, agenda, previous, required, materializedVersion) => {
            const [existing] = await tx
                .select({ field: agendaTextDocs.field })
                .from(agendaTextDocs)
                .where(docWhere(agenda, input.field));
            if (!existing)
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "Fetch the agenda text document before editing",
                    409,
                );
            const { doc, version } = await readDocInTx(
                tx,
                agenda,
                input.field,
                previous,
            );
            try {
                let value: string;
                try {
                    Y.applyUpdate(doc, update);
                    value = materializeAgendaText(doc, required);
                } catch {
                    invalid();
                }
                await storeDocInTx(tx, agenda, input.field, doc, userId);
                const ref = parseAgendaTextField(input.field);
                const at = new Date();
                if (ref.kind === "point")
                    await tx
                        .update(agendaPoints)
                        .set({
                            ...(ref.column === "text"
                                ? { text: encryptText(value) }
                                : {
                                      note: value ? encryptText(value) : null,
                                      noteAt: at,
                                  }),
                            version: sql`${agendaPoints.version} + 1`,
                            updatedAt: at,
                            updatedByUserId: userId,
                        })
                        .where(
                            and(
                                eq(agendaPoints.agendaId, agenda.id),
                                eq(agendaPoints.userId, agenda.userId),
                                eq(agendaPoints.id, ref.id),
                            ),
                        );
                else
                    await tx
                        .update(agendaTasks)
                        .set({
                            note: value ? encryptText(value) : null,
                            version: sql`${agendaTasks.version} + 1`,
                            updatedAt: at,
                            updatedByUserId: userId,
                        })
                        .where(
                            and(
                                eq(agendaTasks.agendaId, agenda.id),
                                eq(agendaTasks.userId, agenda.userId),
                                eq(agendaTasks.taskId, ref.id),
                            ),
                        );
                await tx
                    .update(meetingAgendas)
                    .set({
                        calendarSnapshot: sql`coalesce(${meetingAgendas.calendarSnapshot}, '{}'::jsonb) || jsonb_build_object('editorUserIds', coalesce(${meetingAgendas.calendarSnapshot}->'editorUserIds', '[]'::jsonb) || ${JSON.stringify([userId])}::jsonb)`,
                    })
                    .where(
                        and(
                            eq(meetingAgendas.id, agenda.id),
                            eq(meetingAgendas.userId, agenda.userId),
                            sql`not coalesce(${meetingAgendas.calendarSnapshot}->'editorUserIds', '[]'::jsonb) @> ${JSON.stringify([userId])}::jsonb`,
                        ),
                    );
                await bumpAgendaInTx(tx, agenda);
                return {
                    field: input.field,
                    update: agendaTextBase64(
                        Y.encodeStateAsUpdate(doc, stateVector),
                    ),
                    stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
                    version: version + 1,
                    materializedVersion: materializedVersion + 1,
                };
            } finally {
                doc.destroy();
            }
        },
    );
}
