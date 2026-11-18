"use client";

import { useExtracted } from "next-intl";
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
import { tabEventOrigin } from "@/lib/events/tab-origin";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import { privateTreeFolders } from "@/lib/folders/private-tree";
import { taskFilterFolders } from "@/lib/tasks/folder-filter";
import type {
    TaskAssignee,
    TaskChange,
    TaskListItem,
    TaskTab,
    TaskView,
} from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

const ALL = "all";

function retainChangedRows(
    rows: TaskListItem[],
    previous: TaskListItem[] | null,
    changedIds: ReadonlySet<string>,
    pendingIds: ReadonlySet<string>,
    openRows: ReadonlyMap<string, TaskListItem>,
): TaskListItem[] {
    if (!previous || changedIds.size === 0) return rows;
    const remaining = new Map(rows.map((row) => [row.id, row]));
    const before = new Map<string, TaskListItem[]>();
    let kept: TaskListItem[] = [];
    let lastNeighbor: string | undefined;
    for (const row of previous) {
        if (changedIds.has(row.id)) {
            let fresh = remaining.get(row.id);
            const open = openRows.get(row.id);
            if (open && (!fresh || open.version > fresh.version)) fresh = open;
            kept.push(
                fresh &&
                    (fresh.version > row.version ||
                        (fresh.version === row.version &&
                            !pendingIds.has(row.id)))
                    ? fresh
                    : row,
            );
            remaining.delete(row.id);
        } else if (remaining.has(row.id)) {
            if (kept.length > 0) before.set(row.id, kept);
            kept = [];
            lastNeighbor = row.id;
        }
    }
    const merged = [...remaining.values()].flatMap((row) => [
        ...(before.get(row.id) ?? []),
        row,
        ...(row.id === lastNeighbor ? kept : []),
    ]);
    return lastNeighbor ? merged : [...kept, ...merged];
}

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
    filterFolders = false,
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
    filterFolders?: boolean;
}) {
    const i18n = useExtracted();
    const showMergeFailure = useTaskMergeFailure();
    const [openTaskIds, setOpenTaskIds] = useState<Set<string> | null>(null);
    const [error, setError] = useState(false);
    const folderScope = `${tab}:${allOrganization}`;
    const [taskFolders, setTaskFolders] = useState(new Map<string, string[]>());
    const folderCache = useRef(taskFolders);
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
    const [assignees, setAssignees] = useState<{
        search: string;
        options: TaskAssignee[];
    } | null>(null);
    const knownAssignees = useRef(new Map<string, TaskAssignee>());
    const assigneeRequest = useRef(0);
    const assigneeSearch = useMemo(() => {
        const params = new URLSearchParams();
        if (tab === "all") params.set("tab", "all");
        else if (allOrganization) params.set("organization", "true");
        if (folder !== ALL) params.set("folder", folder);
        return params.size ? `?${params}` : "";
    }, [tab, allOrganization, folder]);
    const visibleAssignees = (assignees?.options ?? []).filter(
        (person) =>
            assignees?.search === assigneeSearch ||
            person.personId === assignee,
    );
    const query = useMemo(() => {
        const search = new URLSearchParams({ tab, state, sort });
        if (allOrganization) search.set("organization", "true");
        if (filterFolders) search.set("folders", "true");
        if (folder !== ALL) search.set("folder", folder);
        if (assignee !== ALL) search.set("assignee", assignee);
        if (due !== ALL) {
            search.set("due", due);
            search.set("today", localToday());
        }
        return search.toString();
    }, [
        tab,
        state,
        sort,
        folder,
        assignee,
        due,
        allOrganization,
        filterFolders,
    ]);

    const scope = useMemo(
        () => ({ query, changedIds: new Set<string>() }),
        [query],
    );
    const currentQuery = useRef(scope);
    currentQuery.current = scope;
    const loadedQuery = useRef(scope);
    const versions = useRef(new Map<string, number>());
    const pending = useRef(new Map<string, Promise<void>>());

    const loadAssignees = useCallback(async () => {
        if (tab === "mine") return;
        const request = ++assigneeRequest.current;
        try {
            const response = await fetch(
                `/api/tasks/assignees${assigneeSearch}`,
            );
            if (!response.ok) throw new Error();
            const body = (await response.json()) as {
                assignees: TaskAssignee[];
            };
            if (request !== assigneeRequest.current) return;
            for (const person of body.assignees) {
                knownAssignees.current.set(person.personId, person);
            }
            if (
                assignee !== ALL &&
                assignee !== "none" &&
                !body.assignees.some((person) => person.personId === assignee)
            ) {
                let known = knownAssignees.current.get(assignee);
                if (!known) {
                    const personResponse = await fetch(
                        `/api/people/${encodeURIComponent(assignee)}`,
                    );
                    if (personResponse.ok) {
                        const { person } = (await personResponse.json()) as {
                            person: { displayName: string; self: boolean };
                        };
                        known = {
                            personId: assignee,
                            name: person.displayName,
                            self: person.self,
                        };
                        knownAssignees.current.set(assignee, known);
                    }
                }
                body.assignees.push(
                    known ?? {
                        personId: assignee,
                        name: i18n("Assignee"),
                    },
                );
            }
            if (request === assigneeRequest.current)
                setAssignees({
                    search: assigneeSearch,
                    options: body.assignees,
                });
        } catch {
            return;
        }
    }, [tab, assignee, i18n, assigneeSearch]);

    useEffect(() => {
        void revision;
        void loadAssignees();
        return () => {
            assigneeRequest.current++;
        };
    }, [loadAssignees, revision]);

    const load = useCallback(
        async (options?: { preserveOwnInserts?: boolean }) => {
            if (scope !== currentQuery.current) return;
            const request = ++loadRequest.current;
            setError(false);
            const reconciled = options?.preserveOwnInserts
                ? []
                : [...ownInserts.current]
                      .filter(([, entry]) => entry.reconciled)
                      .map(([id]) => id);
            const insertedRows = () =>
                [...ownInserts.current.values()]
                    .filter((entry) => entry.query === query)
                    .map((entry) => entry.task);
            try {
                const taskQuery = new URLSearchParams(query);
                const needsFolders =
                    filterFolders && !folderCache.current.has(folderScope);
                if (!needsFolders) taskQuery.delete("folders");
                const openQuery = new URLSearchParams(query);
                openQuery.delete("folders");
                openQuery.set("state", "open");
                const [response, openResponse] = await Promise.all([
                    fetch(`/api/tasks?${taskQuery}`),
                    countOpen && state !== "open" && state !== "all"
                        ? fetch(`/api/tasks?${openQuery}`)
                        : Promise.resolve(null),
                ]);
                if (!response.ok || (openResponse && !openResponse.ok))
                    throw new Error();
                const body = (await response.json()) as {
                    tasks: TaskListItem[];
                    folderIds?: string[];
                };
                const openBody = openResponse
                    ? ((await openResponse.json()) as { tasks: TaskListItem[] })
                    : null;
                if (
                    scope !== currentQuery.current ||
                    request !== loadRequest.current
                )
                    return;
                for (const id of reconciled) ownInserts.current.delete(id);
                const changedIds = new Set(scope.changedIds);
                const pendingIds = new Set(pending.current.keys());
                const inserts = insertedRows().filter(
                    (row) => !changedIds.has(row.id),
                );
                const insertedIds = new Set(inserts.map((task) => task.id));
                const rows = [
                    ...inserts,
                    ...body.tasks.filter((task) => !insertedIds.has(task.id)),
                ];
                const openRows = new Map(
                    openBody?.tasks
                        .filter((row) => row.status === "open")
                        .map((row) => [row.id, row]),
                );
                const nextVersions = new Map(
                    [...versions.current].filter(
                        ([id]) => changedIds.has(id) || pendingIds.has(id),
                    ),
                );
                for (const row of rows) {
                    nextVersions.set(
                        row.id,
                        Math.max(
                            row.version,
                            nextVersions.get(row.id) ?? row.version,
                        ),
                    );
                }
                for (const row of openRows.values()) {
                    if (!changedIds.has(row.id)) continue;
                    nextVersions.set(
                        row.id,
                        Math.max(
                            row.version,
                            nextVersions.get(row.id) ?? row.version,
                        ),
                    );
                }
                versions.current = nextVersions;
                setTasks((previous) =>
                    retainChangedRows(
                        rows,
                        previous,
                        changedIds,
                        pendingIds,
                        openRows,
                    ),
                );
                if (needsFolders) {
                    folderCache.current = new Map(folderCache.current).set(
                        folderScope,
                        body.folderIds ?? [],
                    );
                    setTaskFolders(folderCache.current);
                }
                setOpenTaskIds(openBody ? new Set(openRows.keys()) : null);
            } catch {
                if (
                    scope !== currentQuery.current ||
                    request !== loadRequest.current
                )
                    return;
                setError(true);
                setTasks((current) => current ?? insertedRows());
                toast.error(i18n("Could not load your tasks"));
            }
        },
        [query, scope, i18n, state, countOpen, filterFolders, folderScope],
    );

    useEffect(() => {
        void revision;
        if (loadedQuery.current !== scope) {
            loadedQuery.current = scope;
            setTasks(null);
            setOpenTaskIds(null);
        }
        void load();
        return () => {
            loadRequest.current++;
        };
    }, [load, revision, scope]);

    useEffect(() => {
        if (!markSeen) return;
        void fetch("/api/tasks/pending", { method: "POST" })
            .then(() => announceTasksChanged())
            .catch(() => {});
    }, [markSeen]);

    const reload = useCallback(
        (options?: { preserveOwnInserts?: boolean }) => {
            if (scope !== currentQuery.current) return Promise.resolve([]);
            folderCache.current = new Map();
            setTaskFolders(folderCache.current);
            return Promise.all([load(options), loadAssignees()]);
        },
        [scope, load, loadAssignees],
    );
    const latestReload = useRef(reload);
    latestReload.current = reload;

    useOrgEvents(true, (event) => {
        if (event.type === "recording" && event.origin === tabEventOrigin())
            return;
        void reload();
    });

    const update = (
        task: TaskListItem,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => {
        const changedStatus =
            change.status !== undefined && change.status !== task.status;
        if (changedStatus) scope.changedIds.add(task.id);
        setTasks(
            (current) =>
                current
                    ?.map((row) =>
                        row.id === task.id ? { ...row, ...optimistic } : row,
                    )
                    .filter(
                        (row) =>
                            scope.changedIds.has(row.id) ||
                            ownMatchesFolder(row),
                    ) ?? null,
        );
        const run = (pending.current.get(task.id) ?? Promise.resolve())
            .then(async () => {
                if (changedStatus) scope.changedIds.add(task.id);
                const saved = await changeTask(task.id, {
                    ...change,
                    version: versions.current.get(task.id) ?? task.version,
                });
                versions.current.set(
                    task.id,
                    Math.max(
                        saved.version,
                        versions.current.get(task.id) ?? saved.version,
                    ),
                );
                if (
                    pending.current.get(task.id) === run &&
                    (!changedStatus || scope === currentQuery.current)
                ) {
                    setTasks(
                        (current) =>
                            current?.map((row) =>
                                row.id === task.id &&
                                saved.version >= row.version
                                    ? { ...row, ...saved }
                                    : row,
                            ) ?? null,
                    );
                }
                if (
                    change.assigneePersonId !== undefined ||
                    change.folderId !== undefined ||
                    (changedStatus && scope !== currentQuery.current)
                )
                    await latestReload.current();
            })
            .catch(async (error: unknown) => {
                scope.changedIds.delete(task.id);
                toast.error(
                    error instanceof TaskRequestError && error.conflict
                        ? i18n("Someone changed this meanwhile. Reloaded.")
                        : error instanceof Error && error.message
                          ? error.message
                          : i18n("Could not save the task"),
                );
                versions.current.clear();
                await latestReload.current();
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
            currentQuery.current.changedIds.delete(task.id);
            announceTasksChanged();
            await latestReload.current();
            return { ownerNotified: result.mergeOwnerNotified };
        } catch (error) {
            if (scope === currentQuery.current) setTasks(snapshot);
            else await latestReload.current();
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
                entry?.query === currentQuery.current.query &&
                ownMatchesFolder(task)
                ? [task, ...remaining]
                : remaining;
        });
        if (task && filterFolders)
            void latestReload.current({ preserveOwnInserts: true });
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

    let openCount =
        tasks?.filter((row) => row.status === "open").length ?? null;
    if (state !== "open" && state !== "all") {
        const ids = openTaskIds && new Set(openTaskIds);
        if (ids) {
            for (const row of tasks ?? []) {
                if (!scope.changedIds.has(row.id)) continue;
                if (row.status === "open") ids.add(row.id);
                else ids.delete(row.id);
            }
        }
        openCount = ids?.size ?? null;
    }

    return {
        tasks,
        openCount,
        error,
        reload,
        update,
        merge,
        onAdded,
        onReconciled,
        folders,
        filterFolders: filterFolders
            ? taskFilterFolders(
                  folders,
                  [
                      ...(taskFolders.get(folderScope) ?? []),
                      ...(tab === "mine" || tab === "all"
                          ? [...ownInserts.current.values()].flatMap(
                                ({ task }) =>
                                    task.folder
                                        ? [task.folder.id]
                                        : privateFolders
                                              .filter(
                                                  (entry) =>
                                                      entry.kind === "private",
                                              )
                                              .map((entry) => entry.id),
                            )
                          : []),
                  ],
                  folder === ALL ? undefined : folder,
              )
            : [],
        selectedPrivate,
        visibleAssignees,
    };
}
