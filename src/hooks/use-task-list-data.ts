"use client";

import { useExtracted, useLocale } from "next-intl";
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
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
import { compareNamesBySurname } from "@/lib/people/name-order";
import { taskFilterFolders } from "@/lib/tasks/folder-filter";
import {
    createTaskListState,
    type TaskListPatch,
    type TaskListScope,
    taskListReducer,
    taskListView,
} from "@/lib/tasks/list-state";
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
    const locale = useLocale();
    const showMergeFailure = useTaskMergeFailure();
    const folderScope = `${tab}:${allOrganization}`;
    const [taskFolders, setTaskFolders] = useState(new Map<string, string[]>());
    const folderCache = useRef(taskFolders);
    const ownInserts = useRef(
        new Map<
            string,
            {
                task: TaskListItem;
                scope: TaskListScope | null;
                reconciled: boolean;
            }
        >(),
    );
    const loadRequest = useRef(0);
    const loadedFolders = useTaskFolderTree(initialFolders === undefined);
    const folders = initialFolders ?? loadedFolders;
    const privateFolders = privateTreeFolders(folders);
    const selectedPrivate = privateFolders.find((entry) => entry.id === folder);
    const ownMatchesFolder = (task: TaskView): boolean =>
        folder === ALL ||
        !task.own ||
        Boolean(
            selectedPrivate &&
                (selectedPrivate.kind === "private" ||
                    (task.folder &&
                        descendantFolderIds(
                            privateFolders,
                            selectedPrivate.id,
                        ).has(task.folder.id))),
        );
    const [assignees, setAssignees] = useState<{
        search: string;
        options: TaskAssignee[];
    } | null>(null);
    const [assigneeNames, setAssigneeNames] = useState(
        new Map<string, string>(),
    );
    const assigneeRequest = useRef(0);
    const assigneeSearch = useMemo(() => {
        const params = new URLSearchParams();
        if (tab === "all") params.set("tab", "all");
        else if (allOrganization) params.set("organization", "true");
        if (folder !== ALL) params.set("folder", folder);
        return params.size ? `?${params}` : "";
    }, [tab, allOrganization, folder]);
    const sortedAssignees = useMemo(() => {
        if (assignees?.search !== assigneeSearch) return [];
        const compare = compareNamesBySurname(locale);
        return [...assignees.options].sort((a, b) => compare(a.name, b.name));
    }, [assignees, assigneeSearch, locale]);
    const selectedAssigneeName = assigneeNames.get(assignee);
    const selectedAssigneeLabel =
        assignee === ALL || assignee === "none"
            ? undefined
            : (selectedAssigneeName ?? i18n("Assignee"));
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

    const scope = useMemo(() => ({ query, state }), [query, state]);
    const [list, dispatch] = useReducer(
        taskListReducer,
        scope,
        createTaskListState,
    );
    if (list.scope !== scope) dispatch({ type: "reset", scope });
    const currentScope = useRef(scope);
    currentScope.current = scope;
    const versions = useRef(new Map<string, number>());
    const saves = useRef(new Map<string, Promise<boolean>>());
    const confirmTask = useCallback((row: TaskView) => {
        if (row.version < (versions.current.get(row.id) ?? row.version)) return;
        versions.current.set(row.id, row.version);
        const insert = ownInserts.current.get(row.id);
        if (insert)
            ownInserts.current.set(row.id, {
                ...insert,
                task: { ...insert.task, ...row },
            });
    }, []);

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
            const names = body.assignees.map(
                ({ personId, name }) => [personId, name] as const,
            );
            setAssigneeNames((previous) => new Map([...previous, ...names]));
            setAssignees({ search: assigneeSearch, options: body.assignees });
        } catch {
            if (request === assigneeRequest.current)
                setAssignees((current) =>
                    current?.search === assigneeSearch
                        ? current
                        : { search: assigneeSearch, options: [] },
                );
        }
    }, [tab, assigneeSearch]);

    useEffect(() => {
        void revision;
        void assignee;
        void loadAssignees();
        return () => {
            assigneeRequest.current++;
        };
    }, [loadAssignees, assignee, revision]);

    const loadedAssigneeSearch = assignees?.search;
    useEffect(() => {
        if (
            tab === "mine" ||
            assignee === ALL ||
            assignee === "none" ||
            selectedAssigneeName ||
            loadedAssigneeSearch !== assigneeSearch
        )
            return;
        const controller = new AbortController();
        void fetch(`/api/people/${encodeURIComponent(assignee)}`, {
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) return;
                const { person } = (await response.json()) as {
                    person: { displayName: string };
                };
                if (!controller.signal.aborted)
                    setAssigneeNames((names) =>
                        names.has(assignee)
                            ? names
                            : new Map(names).set(assignee, person.displayName),
                    );
            })
            .catch(() => {});
        return () => controller.abort();
    }, [
        tab,
        assignee,
        selectedAssigneeName,
        loadedAssigneeSearch,
        assigneeSearch,
    ]);

    const load = useCallback(async () => {
        if (scope !== currentScope.current) return;
        const request = ++loadRequest.current;
        dispatch({ type: "loading", scope });
        for (const [id, entry] of ownInserts.current) {
            if (entry.reconciled && entry.scope !== scope)
                ownInserts.current.delete(id);
        }
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
                scope !== currentScope.current ||
                request !== loadRequest.current
            )
                return;
            const openRows =
                openBody?.tasks.filter((row) => row.status === "open") ?? null;
            for (const row of [...body.tasks, ...(openRows ?? [])])
                confirmTask(row);
            dispatch({
                type: "loaded",
                scope,
                rows: body.tasks,
                inserts: [...ownInserts.current.values()]
                    .filter((entry) => entry.scope === scope)
                    .map((entry) => entry.task),
                openRows,
            });
            if (needsFolders) {
                folderCache.current = new Map(folderCache.current).set(
                    folderScope,
                    body.folderIds ?? [],
                );
                setTaskFolders(folderCache.current);
            }
        } catch {
            if (
                scope !== currentScope.current ||
                request !== loadRequest.current
            )
                return;
            dispatch({ type: "loadFailed", scope });
            toast.error(i18n("Could not load your tasks"));
        }
    }, [
        query,
        scope,
        i18n,
        state,
        countOpen,
        filterFolders,
        folderScope,
        confirmTask,
    ]);

    useEffect(() => {
        void revision;
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

    const reload = useCallback(() => {
        if (scope !== currentScope.current) return Promise.resolve([]);
        folderCache.current = new Map();
        setTaskFolders(folderCache.current);
        return Promise.all([load(), loadAssignees()]);
    }, [scope, load, loadAssignees]);
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
        group?: RecordingFolder,
    ) => {
        const id = task.id;
        const patch: TaskListPatch = {
            fields: optimistic,
            retain:
                change.status !== undefined && change.status !== task.status
                    ? { group }
                    : undefined,
        };
        dispatch({ type: "patch", scope, id, patch });
        const run = (saves.current.get(id) ?? Promise.resolve())
            .then(async () => {
                if (!saves.current.has(id)) return false;
                const saved = await changeTask(id, {
                    ...change,
                    version: Math.max(
                        task.version,
                        versions.current.get(id) ?? task.version,
                    ),
                });
                if (!saves.current.has(id)) return false;
                confirmTask(saved);
                dispatch({
                    type: "settlePatch",
                    scope,
                    id,
                    patch,
                    saved,
                });
                return (
                    change.assigneePersonId !== undefined ||
                    change.folderId !== undefined ||
                    scope !== currentScope.current
                );
            })
            .catch((error: unknown) => {
                if (!saves.current.has(id)) return false;
                dispatch({ type: "settlePatch", scope, id, patch });
                toast.error(
                    error instanceof TaskRequestError && error.conflict
                        ? i18n("Someone changed this meanwhile. Reloaded.")
                        : error instanceof Error && error.message
                          ? error.message
                          : i18n("Could not save the task"),
                );
                return true;
            })
            .finally(() => {
                if (saves.current.get(id) === run) saves.current.delete(id);
            });
        saves.current.set(id, run);
        void run.then((shouldReload) => {
            if (shouldReload) void latestReload.current();
        });
    };

    const merge = async (
        task: TaskListItem,
        targetTaskId: string,
        options?: TaskMergeOptions,
    ) => {
        const id = task.id;
        dispatch({ type: "merge", scope, id });
        try {
            const { mergeOwnerNotified, ...survivor } =
                await mergeTaskIntoTarget(id, targetTaskId, options);
            const deletedId = survivor.id === id ? targetTaskId : id;
            ownInserts.current.delete(deletedId);
            versions.current.delete(deletedId);
            saves.current.delete(deletedId);
            confirmTask(survivor);
            dispatch({
                type: "mergeSaved",
                scope: currentScope.current,
                id,
                deletedId,
                survivor,
            });
            announceTasksChanged();
            await latestReload.current();
            return { ownerNotified: mergeOwnerNotified };
        } catch (error) {
            dispatch({ type: "mergeFailed", scope, id });
            if (scope !== currentScope.current) await latestReload.current();
            showMergeFailure(error);
            return false;
        }
    };

    const onReconciled = (temporaryId: string, task: TaskListItem | null) => {
        const entry = ownInserts.current.get(temporaryId);
        ownInserts.current.delete(temporaryId);
        versions.current.delete(temporaryId);
        const current = currentScope.current;
        const show =
            task &&
            ownMatchesFolder(task) &&
            entry?.scope?.query === current.query;
        if (task) {
            confirmTask(task);
            if (entry)
                ownInserts.current.set(task.id, {
                    task,
                    scope: show ? current : null,
                    reconciled: true,
                });
        }
        dispatch({
            type: "reconcile",
            scope: current,
            id: temporaryId,
            row: show ? task : undefined,
        });
        if (task && filterFolders) void latestReload.current();
    };
    const onAdded = (task: TaskListItem) => {
        const matchesFolder = ownMatchesFolder(task);
        ownInserts.current.set(task.id, {
            task,
            scope: matchesFolder ? scope : null,
            reconciled: false,
        });
        if (matchesFolder) dispatch({ type: "insert", scope, row: task });
    };

    const { tasks, openCount } = taskListView(list, ownMatchesFolder);

    return {
        tasks,
        openCount,
        error: list.error,
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
        sortedAssignees,
        selectedAssigneeLabel,
    };
}
