"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { announceLearnReviewsChanged } from "@/components/learn/review-events";
import {
    acceptTaskReview,
    addRecordingTask,
    announceTasksChanged,
    changeTask,
    fetchRecordingTasks,
    mergeTaskProposals,
    TaskRequestError,
    tickTaskUpdate,
} from "@/components/tasks/task-api";
import type {
    RecordingTasks,
    TaskChange,
    TaskUpdateView,
    TaskView,
} from "@/lib/tasks/tasks";

/** A change to one task: what is sent, and what the row shows meanwhile. */
export type TaskRowChange = (
    change: Omit<TaskChange, "version">,
    optimistic: Partial<TaskView>,
) => void;

/** One recording's tasks and the writes on them, shared by its views. */
export interface RecordingTasksState {
    data: RecordingTasks | null;
    failed: boolean;
    /** The reviewer has proposals or follow-ups to decide on. */
    reviewing: boolean;
    /** How many wait: proposals and follow-ups. */
    waiting: number;
    accepting: boolean;
    update: (
        task: TaskView,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => void;
    add: (status: "proposed" | "open") => Promise<void>;
    merge: (ids: readonly string[]) => Promise<boolean>;
    tickUpdate: (update: TaskUpdateView, ticked: boolean) => void;
    /** Accept what is ticked; true when the review is done. */
    accept: () => Promise<boolean>;
}

/**
 * A recording's tasks, read again when `reloadKey` changes (a summary was
 * made). Writes to one row go one after another, each with the version the
 * last one returned; accept and merge wait for them.
 */
export function useRecordingTasks(
    recordingId: string,
    reloadKey: string | number,
): RecordingTasksState {
    const i18n = useExtracted();
    const [data, setData] = useState<RecordingTasks | null>(null);
    const [failed, setFailed] = useState(false);
    const [accepting, setAccepting] = useState(false);
    const dataRef = useRef<RecordingTasks | null>(null);
    dataRef.current = data;
    // Per row: the version the server last returned, and the write in flight.
    const versions = useRef(new Map<string, number>());
    const pending = useRef(new Map<string, Promise<unknown>>());

    const reload = useCallback(async () => {
        try {
            const loaded = await fetchRecordingTasks(recordingId);
            versions.current = new Map([
                ...[...loaded.tasks, ...loaded.proposals].map(
                    (row) => [row.id, row.version] as const,
                ),
                ...loaded.updates.map(
                    (row) => [`update:${row.id}`, row.version] as const,
                ),
            ]);
            setData(loaded);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [recordingId]);

    useEffect(() => {
        void reloadKey;
        setData(null);
        void reload();
    }, [reload, reloadKey]);

    const patchRow = (id: string, patch: Partial<TaskView>) =>
        setData((current) =>
            current
                ? {
                      ...current,
                      tasks: current.tasks.map((row) =>
                          row.id === id ? { ...row, ...patch } : row,
                      ),
                      proposals: current.proposals.map((row) =>
                          row.id === id ? { ...row, ...patch } : row,
                      ),
                  }
                : current,
        );

    const failure = async (error: unknown) => {
        if (error instanceof TaskRequestError && error.conflict) {
            toast.error(i18n("Someone changed this meanwhile. Reloaded."));
        } else {
            toast.error(
                error instanceof Error && error.message
                    ? error.message
                    : i18n("Could not save the task"),
            );
        }
        await reload();
    };

    /** Queue a write on one row behind the writes before it. */
    const enqueue = (key: string, write: () => Promise<void>) => {
        const run = (pending.current.get(key) ?? Promise.resolve())
            .then(write)
            .catch(failure)
            .finally(() => {
                if (pending.current.get(key) === run) {
                    pending.current.delete(key);
                }
            });
        pending.current.set(key, run);
        return run;
    };

    const update: RecordingTasksState["update"] = (
        task,
        change,
        optimistic,
    ) => {
        patchRow(task.id, optimistic);
        void enqueue(task.id, async () => {
            const saved = await changeTask(task.id, {
                ...change,
                version: versions.current.get(task.id) ?? task.version,
            });
            versions.current.set(task.id, saved.version);
            // Later writes queued meanwhile keep their optimistic values.
            const { text, assignee, dueDate, ticked, status, ...rest } = saved;
            patchRow(task.id, {
                ...rest,
                ...(change.text !== undefined && { text }),
                ...(change.assigneePersonId !== undefined && { assignee }),
                ...(change.dueDate !== undefined && { dueDate }),
                ...(change.ticked !== undefined && { ticked }),
                ...(change.status !== undefined && { status }),
            });
            if (change.status) announceTasksChanged();
        });
    };

    const add = async (status: "proposed" | "open") => {
        try {
            const task = await addRecordingTask(recordingId, {
                text: i18n("New task"),
                status,
            });
            versions.current.set(task.id, task.version);
            setData((current) => {
                if (!current) return current;
                if (status === "proposed") {
                    return {
                        ...current,
                        proposals: [...current.proposals, task],
                    };
                }
                return { ...current, tasks: [...current.tasks, task] };
            });
        } catch (error) {
            await failure(error);
        }
    };

    const merge = async (ids: readonly string[]) => {
        if (ids.length < 2) return false;
        try {
            await Promise.all(pending.current.values());
            const kept = await mergeTaskProposals(recordingId, [...ids]);
            versions.current.set(kept.id, kept.version);
            setData((current) =>
                current
                    ? {
                          ...current,
                          proposals: current.proposals
                              .filter(
                                  (row) =>
                                      row.id === kept.id ||
                                      !ids.includes(row.id),
                              )
                              .map((row) => (row.id === kept.id ? kept : row)),
                      }
                    : current,
            );
            return true;
        } catch (error) {
            await failure(error);
            return false;
        }
    };

    const tickUpdate = (update: TaskUpdateView, ticked: boolean) => {
        const key = `update:${update.id}`;
        setData((current) =>
            current
                ? {
                      ...current,
                      updates: current.updates.map((row) =>
                          row.id === update.id ? { ...row, ticked } : row,
                      ),
                  }
                : current,
        );
        void enqueue(key, async () => {
            const version = versions.current.get(key) ?? update.version;
            await tickTaskUpdate(recordingId, update.id, ticked, version);
            versions.current.set(key, version + 1);
        });
    };

    const accept = async () => {
        setAccepting(true);
        try {
            // What the reviewer did last is part of what they accept.
            await Promise.all(pending.current.values());
            const shown = dataRef.current;
            const result = await acceptTaskReview(recordingId, {
                proposals: shown?.proposals.map((row) => row.id) ?? [],
                updates: shown?.updates.map((row) => row.id) ?? [],
            });
            toast.success(
                i18n(
                    "{count, plural, one {# task accepted} other {# tasks accepted}}",
                    { count: result.accepted },
                ),
            );
            if (result.updatesSkipped > 0) {
                toast.info(
                    i18n(
                        "{count, plural, one {# earlier task was} other {# earlier tasks were}} left as they were: closed meanwhile, or not yours to change.",
                        { count: result.updatesSkipped },
                    ),
                );
            }
            announceTasksChanged();
            announceLearnReviewsChanged();
            await reload();
            return true;
        } catch (error) {
            if (error instanceof TaskRequestError && error.conflict) {
                toast.error(
                    i18n(
                        "The proposals changed meanwhile. Look them over again.",
                    ),
                );
                await reload();
            } else {
                await failure(error);
            }
            return false;
        } finally {
            setAccepting(false);
        }
    };

    const waiting = data ? data.proposals.length + data.updates.length : 0;
    return {
        data,
        failed,
        reviewing: Boolean(data?.canEdit) && waiting > 0,
        waiting,
        accepting,
        update,
        add,
        merge,
        tickUpdate,
        accept,
    };
}
