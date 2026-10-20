"use client";

import { ArrowDownWideNarrow, ListChecks, Loader2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { RoutedProposalsInbox } from "@/components/tasks/routed-proposals-inbox";
import {
    announceTasksChanged,
    changeTask,
    mergeTaskIntoTarget,
    TaskRequestError,
} from "@/components/tasks/task-api";
import { localToday } from "@/components/tasks/task-fields";
import { TaskRow } from "@/components/tasks/task-row";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useOrgEvents } from "@/hooks/use-org-events";
import type {
    TaskAssignee,
    TaskChange,
    TaskListItem,
    TaskView,
} from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

const ALL = "all";

function localizedMergeRule(
    message: string,
    copy: {
        visible: string;
        open: string;
        organization: string;
        curator: string;
        ownerOrCurator: string;
        owner: string;
        shareFirst: string;
    },
): string {
    switch (message) {
        case "Merge rule: both tasks must be visible to the person merging":
            return copy.visible;
        case "Merge rule: the target must be an open task":
            return copy.open;
        case "Merge rule: an Organization task can be merged only into an Organization task":
            return copy.organization;
        case "Merge rule: merging someone else's task into your own requires a curator":
            return copy.curator;
        case "Merge rule: only the home owner or a curator may merge that owner's tasks":
            return copy.ownerOrCurator;
        case "Merge rule: only the merged task's home owner may attach it to someone else's task":
            return copy.owner;
        case "Merge rule: a private task can join an Organization task only after its home item is shared":
            return copy.shareFirst;
        default:
            return message;
    }
}

interface MergeFailureCopy {
    visible: string;
    open: string;
    organization: string;
    curator: string;
    ownerOrCurator: string;
    owner: string;
    shareFirst: string;
    fallback: string;
}

/** Shows the server's merge refusal in the Tasks UI. */
export function showTaskMergeFailure(
    error: unknown,
    copy: MergeFailureCopy,
): void {
    if (error instanceof TaskRequestError && error.status === 403) {
        toast.error(localizedMergeRule(error.message, copy));
        return;
    }
    toast.error(
        error instanceof Error && error.message ? error.message : copy.fallback,
    );
}

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
export function TaskList({ organization }: { organization: boolean }) {
    const i18n = useExtracted();
    const locale = useLocale();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const tab = organization
        ? "tracked"
        : params.get("tab") === "tracked"
          ? "tracked"
          : "mine";
    const state = params.get("state") ?? "open";
    const folder = params.get("folder") ?? ALL;
    const assignee = tab === "tracked" ? params.get("assignee") || ALL : ALL;
    const due = params.get("due") ?? ALL;
    const sort = params.get("sort") === "due" ? "due" : "created";

    const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
    const [folders, setFolders] = useState<RecordingFolder[]>([]);
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
        if (folder !== ALL) search.set("folder", folder);
        if (assignee !== ALL) search.set("assignee", assignee);
        if (due !== ALL) {
            search.set("due", due);
            search.set("today", localToday());
        }
        return search.toString();
    }, [tab, state, sort, folder, assignee, due]);

    const loadAssignees = useCallback(async () => {
        if (tab !== "tracked") return;
        const request = ++assigneeRequest.current;
        try {
            const response = await fetch("/api/tasks/assignees");
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
    }, [tab, assignee, i18n]);

    useEffect(() => {
        void loadAssignees();
        return () => {
            assigneeRequest.current++;
        };
    }, [loadAssignees]);

    const load = useCallback(async () => {
        try {
            const response = await fetch(`/api/tasks?${query}`);
            if (!response.ok) throw new Error();
            const body = (await response.json()) as { tasks: TaskListItem[] };
            versions.current = new Map(
                body.tasks.map((task) => [task.id, task.version]),
            );
            setTasks(body.tasks);
        } catch {
            setTasks([]);
            toast.error(i18n("Could not load your tasks"));
        }
    }, [query, i18n]);

    useEffect(() => {
        setTasks(null);
        void load();
    }, [load]);

    // Opening the list is seeing what is new.
    useEffect(() => {
        void fetch("/api/tasks/pending", { method: "POST" })
            .then(() => announceTasksChanged())
            .catch(() => {});
    }, []);

    useEffect(() => {
        void fetch("/api/folders")
            .then((response) => (response.ok ? response.json() : null))
            .then((body: FolderOrganization | null) =>
                setFolders(body?.folders ?? []),
            )
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
                current?.map((row) =>
                    row.id === task.id ? { ...row, ...optimistic } : row,
                ) ?? null,
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

    const merge = async (task: TaskListItem, targetTaskId: string) => {
        const snapshot = tasks;
        setTasks(
            (current) => current?.filter((row) => row.id !== task.id) ?? null,
        );
        try {
            const result = await mergeTaskIntoTarget(task.id, targetTaskId);
            announceTasksChanged();
            void loadAssignees();
            return { ownerNotified: result.mergeOwnerNotified };
        } catch (error) {
            setTasks(snapshot);
            showTaskMergeFailure(error, {
                visible: i18n(
                    "Merge rule: you must be able to see both tasks.",
                ),
                open: i18n("Merge rule: the target must be an open task."),
                organization: i18n(
                    "Merge rule: an Organization task can only join another Organization task.",
                ),
                curator: i18n(
                    "Merge rule: a curator must merge someone else's task into yours.",
                ),
                ownerOrCurator: i18n(
                    "Merge rule: only the task's home owner or a curator may merge it.",
                ),
                owner: i18n(
                    "Merge rule: only the merged task's home owner may attach it to someone else's task.",
                ),
                shareFirst: i18n(
                    "Merge rule: share the private task's home item before merging it into an Organization task.",
                ),
                fallback: i18n("Could not merge the tasks"),
            });
            return false;
        }
    };

    const tabs = organization
        ? []
        : [
              { key: "mine", label: i18n("Mine") },
              { key: "tracked", label: i18n("Tracked") },
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
                                    "Assigned to you, from your recordings and the Organization's.",
                                )
                              : i18n(
                                    "The other tasks from your recordings: assigned to others, or to nobody yet.",
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
                                        {entry.kind === "private"
                                            ? i18n("Private")
                                            : entry.scope === "org" &&
                                                entry.parentId === null
                                              ? i18n("Organization")
                                              : entry.name}
                                    </span>
                                </SelectItem>
                            ),
                        )}
                    </SelectContent>
                </Select>
                {tab === "tracked" && (
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

            {tasks === null ? (
                <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {i18n("Loading tasks…")}
                </p>
            ) : tasks.length === 0 ? (
                <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {tab === "mine"
                        ? i18n(
                              "Nothing here. Tasks assigned to you appear once a recording's tasks are accepted.",
                          )
                        : i18n("Nothing here.")}
                </p>
            ) : (
                <ul className="divide-y rounded-lg border">
                    {tasks.map((task) => (
                        <TaskRow
                            key={task.id}
                            task={task}
                            recording={task.recording}
                            evidence={task.evidence}
                            showAssignee={tab === "tracked" || task.canEdit}
                            organizationOnly={task.recording.view === "org"}
                            onChange={(change, optimistic) =>
                                update(task, change, optimistic)
                            }
                            onMerge={(targetTaskId) =>
                                merge(task, targetTaskId)
                            }
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
