"use client";

import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    announceTasksChanged,
    changeTask,
    mergeTaskIntoTarget,
    type TaskMergeOptions,
    TaskRequestError,
} from "@/components/tasks/task-api";
import { localToday } from "@/components/tasks/task-fields";
import { useTaskMergeFailure } from "@/components/tasks/task-merge-feedback";
import { useOrgEvents } from "@/hooks/use-org-events";
import { useTaskFolderTree } from "@/hooks/use-task-folder-tree";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import { privateTreeFolders } from "@/lib/folders/private-tree";
import type {
    TaskAssignee,
    TaskChange,
    TaskListItem,
    TaskTab,
    TaskView,
} from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

const ALL = "all";

/** Shared task queries, optimistic inserts and serialized versioned mutations. */
export function useTaskListData({
    tab,
    state,
    folder = ALL,
    assignee = ALL,
    due = ALL,
    sort = "created",
    allOrganization = false,
    initialFolders,
    countOpen = false,
    revision,
    markSeen = false,
}: {
    tab: TaskTab;
    state: string;
    folder?: string;
    assignee?: string;
    due?: string;
    sort?: string;
    allOrganization?: boolean;
    initialFolders?: RecordingFolder[];
    countOpen?: boolean;
    revision?: string;
    markSeen?: boolean;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const showMergeFailure = useTaskMergeFailure();
    const [openCount, setOpenCount] = useState<number | null>(null);
    const [error, setError] = useState(false);
    const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
    const ownInserts = useRef(
        new Map<
            string,
            { task: TaskListItem; query: string | null; reconciled: boolean }
        >(),
    );
    const loadRequest = useRef(0);
    const loadedFolders = useTaskFolderTree(initialFolders === undefined);
    const folders = initialFolders ?? loadedFolders;
    const privateFolders = privateTreeFolders(folders);
    const selectedPrivate = privateFolders.find((entry) => entry.id === folder);
    const ownMatchesFolder = (task: TaskListItem) =>
        folder === ALL ||
        !task.own ||
        (selectedPrivate &&
            (selectedPrivate.kind === "private" ||
                (task.folder &&
                    descendantFolderIds(privateFolders, selectedPrivate.id).has(
                        task.folder.id,
                    ))));
    const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
    const assigneeNames = useRef(new Map<string, string>());
    const assigneeRequest = useRef(0);
    const sortedAssignees = useMemo(
        () =>
            [...assignees].sort((a, b) => a.name.localeCompare(b.name, locale)),
        [assignees, locale],
    );
    const query = useMemo(() => {
        const search = new URLSearchParams({ tab, state, sort });
        if (allOrganization) search.set("organization", "true");
        if (folder !== ALL) search.set("folder", folder);
        if (assignee !== ALL) search.set("assignee", assignee);
        if (due !== ALL) {
            search.set("due", due);
            search.set("today", localToday());
        }
        return search.toString();
    }, [tab, state, sort, folder, assignee, due, allOrganization]);

    const currentQuery = useRef(query);
    currentQuery.current = query;

    const loadAssignees = useCallback(async () => {
        if (tab === "mine") return;
        const request = ++assigneeRequest.current;
        try {
            const response = await fetch(
                `/api/tasks/assignees${tab === "all" ? "?tab=all" : allOrganization ? "?organization=true" : ""}`,
            );
            if (!response.ok) throw new Error();
            const body = (await response.json()) as {
                assignees: TaskAssignee[];
            };
            if (request !== assigneeRequest.current) return;
            for (const person of body.assignees) {
                assigneeNames.current.set(person.personId, person.name);
            }
            if (
                assignee !== ALL &&
                assignee !== "none" &&
                !body.assignees.some((person) => person.personId === assignee)
            ) {
                let name = assigneeNames.current.get(assignee);
                if (!name) {
                    const personResponse = await fetch(
                        `/api/people/${encodeURIComponent(assignee)}`,
                    );
                    if (personResponse.ok) {
                        const { person } = (await personResponse.json()) as {
                            person: { displayName: string };
                        };
                        name = person.displayName;
                        assigneeNames.current.set(assignee, name);
                    }
                }
                body.assignees.push({
                    personId: assignee,
                    name: name ?? i18n("Assignee"),
                });
            }
            if (request === assigneeRequest.current)
                setAssignees(body.assignees);
        } catch {
            return;
        }
    }, [tab, assignee, i18n, allOrganization]);

    useEffect(() => {
        void loadAssignees();
        return () => {
            assigneeRequest.current++;
        };
    }, [loadAssignees]);

    const load = useCallback(async () => {
        const request = ++loadRequest.current;
        setError(false);
        const reconciled = [...ownInserts.current]
            .filter(([, entry]) => entry.reconciled)
            .map(([id]) => id);
        const insertedRows = () =>
            [...ownInserts.current.values()]
                .filter((entry) => entry.query === query)
                .map((entry) => entry.task);
        try {
            const openQuery = new URLSearchParams(query);
            openQuery.set("state", "open");
            const [response, openResponse] = await Promise.all([
                fetch(`/api/tasks?${query}`),
                countOpen && state !== "open" && state !== "all"
                    ? fetch(`/api/tasks?${openQuery}`)
                    : Promise.resolve(null),
            ]);
            if (!response.ok || (openResponse && !openResponse.ok))
                throw new Error();
            const body = (await response.json()) as { tasks: TaskListItem[] };
            const openBody = openResponse
                ? ((await openResponse.json()) as { tasks: TaskListItem[] })
                : body;
            if (request !== loadRequest.current) return;
            for (const id of reconciled) ownInserts.current.delete(id);
            const inserts = insertedRows();
            const insertedIds = new Set(inserts.map((task) => task.id));
            const rows = [
                ...inserts,
                ...body.tasks.filter((task) => !insertedIds.has(task.id)),
            ];
            versions.current = new Map(
                rows.map((task) => [task.id, task.version]),
            );
            setTasks(rows);
            setOpenCount(
                openBody.tasks.filter((task) => task.status === "open").length,
            );
        } catch {
            if (request !== loadRequest.current) return;
            setError(true);
            setTasks(insertedRows());
            toast.error(i18n("Could not load your tasks"));
        }
    }, [query, i18n, state, countOpen]);

    useEffect(() => {
        void revision;
        setTasks(null);
        setOpenCount(null);
        void load();
        return () => {
            loadRequest.current++;
        };
    }, [load, revision]);

    useEffect(() => {
        if (!markSeen) return;
        void fetch("/api/tasks/pending", { method: "POST" })
            .then(() => announceTasksChanged())
            .catch(() => {});
    }, [markSeen]);

    const reload = useCallback(
        () => Promise.all([load(), loadAssignees()]),
        [load, loadAssignees],
    );

    useOrgEvents(true, () => void reload());

    const versions = useRef(new Map<string, number>());
    const pending = useRef(new Map<string, Promise<void>>());

    const update = (
        task: TaskListItem,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => {
        setTasks(
            (current) =>
                current
                    ?.map((row) =>
                        row.id === task.id ? { ...row, ...optimistic } : row,
                    )
                    .filter(ownMatchesFolder) ?? null,
        );
        const run = (pending.current.get(task.id) ?? Promise.resolve())
            .then(async () => {
                const saved = await changeTask(task.id, {
                    ...change,
                    version: versions.current.get(task.id) ?? task.version,
                });
                versions.current.set(task.id, saved.version);
                if (pending.current.get(task.id) === run) {
                    setTasks(
                        (current) =>
                            current?.map((row) =>
                                row.id === task.id ? { ...row, ...saved } : row,
                            ) ?? null,
                    );
                }
                if (change.assigneePersonId !== undefined) await reload();
            })
            .catch(async (error: unknown) => {
                toast.error(
                    error instanceof TaskRequestError && error.conflict
                        ? i18n("Someone changed this meanwhile. Reloaded.")
                        : error instanceof Error && error.message
                          ? error.message
                          : i18n("Could not save the task"),
                );
                versions.current.clear();
                await reload();
            })
            .finally(() => {
                if (pending.current.get(task.id) === run) {
                    pending.current.delete(task.id);
                }
            });
        pending.current.set(task.id, run);
    };

    const merge = async (
        task: TaskListItem,
        targetTaskId: string,
        options?: TaskMergeOptions,
    ) => {
        const snapshot = tasks;
        setTasks(
            (current) => current?.filter((row) => row.id !== task.id) ?? null,
        );
        try {
            const result = await mergeTaskIntoTarget(
                task.id,
                targetTaskId,
                options,
            );
            announceTasksChanged();
            await reload();
            return { ownerNotified: result.mergeOwnerNotified };
        } catch (error) {
            setTasks(snapshot);
            showMergeFailure(error);
            return false;
        }
    };

    const onReconciled = (temporaryId: string, task: TaskListItem | null) => {
        const entry = ownInserts.current.get(temporaryId);
        if (task && entry)
            ownInserts.current.set(temporaryId, {
                ...entry,
                task,
                reconciled: true,
            });
        else ownInserts.current.delete(temporaryId);
        versions.current.delete(temporaryId);
        if (task) versions.current.set(task.id, task.version);
        setTasks((current) => {
            const remaining = (current ?? []).filter(
                (row) => row.id !== temporaryId && row.id !== task?.id,
            );
            return task &&
                entry?.query === currentQuery.current &&
                ownMatchesFolder(task)
                ? [task, ...remaining]
                : remaining;
        });
    };
    const onAdded = (task: TaskListItem) => {
        ownInserts.current.set(task.id, {
            task,
            query: ownMatchesFolder(task) ? query : null,
            reconciled: false,
        });
        versions.current.set(task.id, task.version);
        setTasks((current) =>
            ownMatchesFolder(task) ? [task, ...(current ?? [])] : current,
        );
    };

    return {
        tasks,
        openCount:
            state === "open" || state === "all"
                ? (tasks?.filter((task) => task.status === "open").length ??
                  null)
                : openCount,
        error,
        reload,
        update,
        merge,
        onAdded,
        onReconciled,
        folders,
        selectedPrivate,
        sortedAssignees,
    };
}
