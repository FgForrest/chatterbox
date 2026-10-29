"use client";

import { ArrowDownWideNarrow, ListChecks, Loader2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { OwnTaskForm } from "@/components/tasks/own-task-form";
import { RoutedProposalsInbox } from "@/components/tasks/routed-proposals-inbox";
import {
    announceTasksChanged,
    changeTask,
    mergeTaskIntoTarget,
    type TaskMergeOptions,
    TaskRequestError,
} from "@/components/tasks/task-api";
import { localToday } from "@/components/tasks/task-fields";
import { useTaskMergeFailure } from "@/components/tasks/task-merge-feedback";
import { TaskRow } from "@/components/tasks/task-row";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useOrgEvents } from "@/hooks/use-org-events";
import { useTaskFolderTree } from "@/hooks/use-task-folder-tree";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import { privateTreeFolders } from "@/lib/folders/private-tree";
import type {
    TaskAssignee,
    TaskChange,
    TaskListItem,
    TaskView,
} from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";

const ALL = "all";

/** A folder with its depth, for an indented picker. */
function flattenFolders(
    folders: readonly RecordingFolder[],
): { folder: RecordingFolder; depth: number }[] {
    const children = new Map<string | null, RecordingFolder[]>();
    for (const folder of folders) {
        const siblings = children.get(folder.parentId) ?? [];
        siblings.push(folder);
        children.set(folder.parentId, siblings);
    }
    const out: { folder: RecordingFolder; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
        for (const folder of (children.get(parentId) ?? []).sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        )) {
            out.push({ folder, depth });
            walk(folder.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}

/**
 * The viewer's tasks across recordings: theirs to do, or the ones they keep
 * track of; filtered by state, folder, assignee and deadline, newest first
 * or by due date. Filters live in the URL, so a filtered list can be bookmarked.
 */
export function TaskList({
    organization,
    canCurate = false,
}: {
    organization: boolean;
    canCurate?: boolean;
}) {
    const i18n = useExtracted();
    const showMergeFailure = useTaskMergeFailure();
    const folderLabel = useFolderLabel();
    const locale = useLocale();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const tab =
        organization ||
        ["tracked", "followed"].includes(params.get("tab") ?? "")
            ? "followed"
            : "mine";
    const [addOpen, setAddOpen] = useState(false);
    const addRequest = params.get("add");
    useEffect(() => {
        setAddOpen(Boolean(addRequest));
    }, [addRequest]);
    const allOrganization = canCurate && params.get("organization") === "true";
    const state = params.get("state") ?? "open";
    const folder = params.get("folder") ?? ALL;
    const assignee = tab === "followed" ? params.get("assignee") || ALL : ALL;
    const due = params.get("due") ?? ALL;
    const sort = params.get("sort") === "due" ? "due" : "created";

    const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
    const ownInserts = useRef(
        new Map<
            string,
            { task: TaskListItem; query: string | null; reconciled: boolean }
        >(),
    );
    const loadRequest = useRef(0);
    const folders = useTaskFolderTree();
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
    const setParam = (key: string, value: string | null) => {
        const next = new URLSearchParams(params.toString());
        if (value === null || (value === ALL && key !== "state"))
            next.delete(key);
        else next.set(key, value);
        const query = next.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    };

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
        if (tab !== "followed") return;
        const request = ++assigneeRequest.current;
        try {
            const response = await fetch(
                `/api/tasks/assignees${allOrganization ? "?organization=true" : ""}`,
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
        const reconciled = [...ownInserts.current]
            .filter(([, entry]) => entry.reconciled)
            .map(([id]) => id);
        const insertedRows = () =>
            [...ownInserts.current.values()]
                .filter((entry) => entry.query === query)
                .map((entry) => entry.task);
        try {
            const response = await fetch(`/api/tasks?${query}`);
            if (!response.ok) throw new Error();
            const body = (await response.json()) as { tasks: TaskListItem[] };
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
        } catch {
            if (request !== loadRequest.current) return;
            setTasks(insertedRows());
            toast.error(i18n("Could not load your tasks"));
        }
    }, [query, i18n]);

    useEffect(() => {
        setTasks(null);
        void load();
        return () => {
            loadRequest.current++;
        };
    }, [load]);

    // Opening the list is seeing what is new.
    useEffect(() => {
        void fetch("/api/tasks/pending", { method: "POST" })
            .then(() => announceTasksChanged())
            .catch(() => {});
    }, []);

    const reload = useCallback(
        () => Promise.all([load(), loadAssignees()]),
        [load, loadAssignees],
    );

    useOrgEvents(true, () => void reload());

    // Per row: the version the server last returned, and the write in
    // flight, so quick changes to one row go one after another.
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

    const tabs = organization
        ? []
        : [
              { key: "mine", label: i18n("Mine") },
              { key: "followed", label: i18n("Followed") },
          ];

    return (
        <div className="mx-auto max-w-4xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-xl font-semibold">
                        <ListChecks className="size-5 text-primary" />
                        {i18n("Tasks")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {organization
                            ? i18n("Tasks from the Organization's recordings.")
                            : tab === "mine"
                              ? i18n(
                                    "Assigned to you, including your own private tasks.",
                                )
                              : i18n(
                                    "Tasks you follow, and tasks from your items assigned to others.",
                                )}
                    </p>
                </div>
                {tabs.length > 0 && (
                    <nav
                        aria-label={i18n("Task lists")}
                        className="inline-flex rounded-lg bg-muted/70 p-1"
                    >
                        {tabs.map((entry) => (
                            <button
                                key={entry.key}
                                type="button"
                                aria-pressed={tab === entry.key}
                                onClick={() =>
                                    setParam(
                                        "tab",
                                        entry.key === "mine" ? null : entry.key,
                                    )
                                }
                                className={cn(
                                    "rounded-md px-3 py-1.5 text-sm font-medium transition-all",
                                    tab === entry.key
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                                )}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </nav>
                )}
            </div>

            <RoutedProposalsInbox />

            <div className="flex flex-wrap items-center gap-2">
                {canCurate && tab === "followed" && (
                    <Select
                        value={allOrganization ? "organization" : "followed"}
                        onValueChange={(value) =>
                            setParam(
                                "organization",
                                value === "organization" ? "true" : null,
                            )
                        }
                    >
                        <SelectTrigger
                            className="h-8 w-52 text-xs"
                            aria-label={i18n("Followed task scope")}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="followed">
                                {i18n("Followed")}
                            </SelectItem>
                            <SelectItem value="organization">
                                {i18n("All Organization tasks")}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                )}

                <Select
                    value={state}
                    onValueChange={(value) =>
                        setParam("state", value === "open" ? null : value)
                    }
                >
                    <SelectTrigger
                        className="h-8 w-32 text-xs"
                        aria-label={i18n("State")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="open">
                            {i18n("Open tasks")}
                        </SelectItem>
                        <SelectItem value="done">{i18n("Done")}</SelectItem>
                        <SelectItem value="dropped">
                            {i18n("Dropped")}
                        </SelectItem>
                        <SelectItem value="all">
                            {i18n("All states")}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <Select
                    value={folder}
                    onValueChange={(value) => setParam("folder", value)}
                >
                    <SelectTrigger
                        className="h-8 w-48 text-xs"
                        aria-label={i18n("Folder")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>
                            {i18n("All folders")}
                        </SelectItem>
                        {flattenFolders(folders).map(
                            ({ folder: entry, depth }) => (
                                <SelectItem key={entry.id} value={entry.id}>
                                    <span
                                        style={{
                                            paddingLeft: `${depth * 12}px`,
                                        }}
                                    >
                                        {folderLabel(entry)}
                                    </span>
                                </SelectItem>
                            ),
                        )}
                    </SelectContent>
                </Select>
                {tab === "followed" && (
                    <Select
                        value={assignee}
                        onValueChange={(value) => setParam("assignee", value)}
                    >
                        <SelectTrigger
                            className="h-8 w-48 text-xs"
                            aria-label={i18n("Assignee")}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL}>
                                {i18n("All assignees")}
                            </SelectItem>
                            <SelectItem value="none">
                                {i18n("No assignee")}
                            </SelectItem>
                            {sortedAssignees.map((person) => (
                                <SelectItem
                                    key={person.personId}
                                    value={person.personId}
                                >
                                    {person.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                <Select
                    value={due}
                    onValueChange={(value) => setParam("due", value)}
                >
                    <SelectTrigger
                        className="h-8 w-36 text-xs"
                        aria-label={i18n("Due")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>
                            {i18n("Any due date")}
                        </SelectItem>
                        <SelectItem value="overdue">
                            {i18n("Overdue")}
                        </SelectItem>
                        <SelectItem value="week">
                            {i18n("Due this week")}
                        </SelectItem>
                        <SelectItem value="none">
                            {i18n("No due date")}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <button
                    type="button"
                    onClick={() =>
                        setParam("sort", sort === "due" ? null : "due")
                    }
                    aria-pressed={sort === "due"}
                    className={cn(
                        "ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors",
                        sort === "due"
                            ? "border-primary text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    <ArrowDownWideNarrow className="size-3.5" />
                    {sort === "due"
                        ? i18n("By due date")
                        : i18n("Newest first")}
                </button>
            </div>

            <ul className="divide-y rounded-lg border">
                {tasks === null ? (
                    <li className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {i18n("Loading tasks…")}
                    </li>
                ) : tasks.length === 0 ? (
                    <li className="p-8 text-center text-sm text-muted-foreground">
                        {i18n("Nothing here.")}
                    </li>
                ) : (
                    tasks.map((task) => (
                        <TaskRow
                            key={task.id}
                            task={task}
                            folders={folders}
                            recording={task.recording}
                            evidence={task.evidence}
                            showAssignee={tab !== "mine" || task.canEdit}
                            organizationOnly={task.recording?.view === "org"}
                            onChange={(change, optimistic) =>
                                update(task, change, optimistic)
                            }
                            onMerge={(targetTaskId, options) =>
                                merge(task, targetTaskId, options)
                            }
                            onFollow={() => void reload()}
                        />
                    ))
                )}
            </ul>
            {!organization && tab === "mine" && (
                <OwnTaskForm
                    open={addOpen}
                    focusRequest={addRequest}
                    folders={folders}
                    defaultFolderId={
                        selectedPrivate?.kind === "private"
                            ? null
                            : (selectedPrivate?.id ?? null)
                    }
                    onOpenChange={(open) => {
                        setAddOpen(open);
                        if (!open && addRequest) setParam("add", null);
                    }}
                    onReconciled={(temporaryId, task) => {
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
                                (row) =>
                                    row.id !== temporaryId &&
                                    row.id !== task?.id,
                            );
                            return task &&
                                entry?.query === currentQuery.current &&
                                ownMatchesFolder(task)
                                ? [task, ...remaining]
                                : remaining;
                        });
                    }}
                    onAdded={(task) => {
                        ownInserts.current.set(task.id, {
                            task,
                            query: ownMatchesFolder(task) ? query : null,
                            reconciled: false,
                        });
                        versions.current.set(task.id, task.version);
                        setTasks((current) =>
                            ownMatchesFolder(task)
                                ? [task, ...(current ?? [])]
                                : current,
                        );
                    }}
                />
            )}
        </div>
    );
}
