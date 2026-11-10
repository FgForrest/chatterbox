import { z } from "zod";
import { AppError, ErrorCode } from "@/lib/errors";

const id = z.string().min(1).max(255);
export const agendaTaskIdsInput = z
    .array(id)
    .min(1)
    .max(500)
    .transform((ids) => [...new Set(ids)]);
export const addAgendaTasksInput = z.union([
    z.object({ taskIds: agendaTaskIdsInput, taskId: z.never().optional() }),
    z.object({ taskId: id, taskIds: z.never().optional() }),
]);
const line = z
    .string()
    .trim()
    .max(2000)
    .refine((value) => !/[\r\n]/u.test(value), "Use a single line");
const instant = z.iso.datetime({ offset: true });
export const createMeetingInput = z.object({
    folderId: id,
    calendarEventId: id.optional(),
    title: line.min(1).max(500).optional(),
    start: instant.optional(),
    end: instant.optional(),
});
export const taskGroupOrderInput = z
    .array(z.string().min(1).max(2000))
    .max(500)
    .refine(
        (keys) => new Set(keys).size === keys.length,
        "Duplicate group keys",
    );
export const reorderAgendaTasksInput = z.object({
    groupKey: z.string().min(1).max(2000),
    taskIds: z
        .array(id)
        .min(1)
        .max(500)
        .refine(
            (ids) => new Set(ids).size === ids.length,
            "Duplicate task ids",
        ),
});
const meetingPrevious = z.object({
    title: line.min(1).max(500).optional(),
    start: instant.nullable().optional(),
    end: instant.nullable().optional(),
    calendarEventId: id.nullable().optional(),
    taskSourceItemId: id.nullable().optional(),
    noTaskSource: z.boolean().optional(),
    taskGroupOrder: taskGroupOrderInput.optional(),
});
export const patchMeetingInput = z
    .object({
        title: line.min(1).max(500).optional(),
        start: instant.nullable().optional(),
        end: instant.nullable().optional(),
        calendarEventId: id.nullable().optional(),
        taskSourceItemId: id.nullable().optional(),
        noTaskSource: z.boolean().optional(),
        taskGroupOrder: taskGroupOrderInput.optional(),
        state: z.enum(["planned", "live", "held"]).optional(),
        version: z.number().int().nonnegative().optional(),
        previous: meetingPrevious.optional(),
    })
    .superRefine((input, ctx) => {
        if (
            input.taskGroupOrder !== undefined &&
            !input.previous?.taskGroupOrder
        )
            ctx.addIssue({
                code: "custom",
                path: ["previous", "taskGroupOrder"],
                message: "Previous value is required",
            });
        if (!input.previous) return;
        const patchesTaskSource =
            input.taskSourceItemId !== undefined ||
            input.noTaskSource !== undefined;
        for (const field of [
            "title",
            "start",
            "end",
            "calendarEventId",
            "taskSourceItemId",
            "noTaskSource",
            "taskGroupOrder",
        ] as const) {
            if (
                (input[field] !== undefined ||
                    (patchesTaskSource &&
                        (field === "taskSourceItemId" ||
                            field === "noTaskSource"))) &&
                input.previous[field] === undefined
            )
                ctx.addIssue({
                    code: "custom",
                    path: ["previous", field],
                    message: "Previous value is required",
                });
        }
    });
export const createPointInput = z.object({
    text: line.min(1),
    parentId: id.nullable().optional(),
    position: z.number().int().nonnegative().max(100000).optional(),
    siblingIndex: z.number().int().nonnegative().max(100000).optional(),
    origin: z.enum(["manual", "live"]).optional(),
});
export const patchPointInput = createPointInput
    .omit({ origin: true })
    .partial()
    .extend({
        version: z.number().int().nonnegative(),
        siblingIndex: z.number().int().nonnegative().max(100000).optional(),
        discussed: z.boolean().optional(),
        mergeUp: z.boolean().optional(),
        note: line.nullable().optional(),
    });
export const patchAgendaTaskInput = z.object({
    note: line.nullable().optional(),
    removed: z.boolean().optional(),
});

export interface TreePoint {
    id: string;
    parentId: string | null;
    position: number;
}

/** Reject cycles, cross-agenda parents and any move that would exceed three levels. */
export function validatePointTree(points: readonly TreePoint[]) {
    const byId = new Map(points.map((point) => [point.id, point]));
    for (const point of points) {
        const seen = new Set([point.id]);
        let parentId = point.parentId;
        let depth = 1;
        while (parentId) {
            const parent = byId.get(parentId);
            if (!parent || seen.has(parentId) || ++depth > 3)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Agenda points must form a tree of at most three levels",
                    400,
                );
            seen.add(parentId);
            parentId = parent.parentId;
        }
    }
}

/** The same half-of-either-window overlap used for Calendar roster matching. */
export function meetingOverlap(
    start: Date,
    end: Date,
    plannedStart: Date,
    plannedEnd: Date,
): number {
    const duration = end.getTime() - start.getTime();
    const plannedDuration = plannedEnd.getTime() - plannedStart.getTime();
    const overlap =
        Math.min(end.getTime(), plannedEnd.getTime()) -
        Math.max(start.getTime(), plannedStart.getTime());
    return duration > 0 &&
        plannedDuration > 0 &&
        overlap > 0 &&
        (overlap >= duration / 2 || overlap >= plannedDuration / 2)
        ? overlap
        : 0;
}

export { groupAgendaTasks } from "./task-groups";
