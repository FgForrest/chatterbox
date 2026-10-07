"use client";

import { ArrowDownWideNarrow, ListChecks, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssigneePicker } from "@/components/tasks/assignee-picker";
import {
    announceTasksChanged,
    changeTask,
    TaskRequestError,
} from "@/components/tasks/task-api";
import { DueDateField, localToday } from "@/components/tasks/task-fields";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useOrgEvents } from "@/hooks/use-org-events";
import type { TaskChange, TaskListItem } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

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
 * track of; filtered by state, folder and deadline, newest first or by due
 * date. Filters live in the URL, so a filtered list can be bookmarked.
 */
export function TaskList({ organization }: { organization: boolean }) {
    const i18n = useExtracted();
    const format = useFormatter();
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
    const due = params.get("due") ?? ALL;
    const sort = params.get("sort") === "due" ? "due" : "created";

    const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
    const [folders, setFolders] = useState<RecordingFolder[]>([]);

    const setParam = (key: string, value: string | null) => {
        const next = new URLSearchParams(params.toString());
        if (value === null || value === ALL) next.delete(key);
        else next.set(key, value);
        const query = next.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    };

    const query = useMemo(() => {
        const search = new URLSearchParams({ tab, state, sort });
        if (folder !== ALL) search.set("folder", folder);
        if (due !== ALL) {
            search.set("due", due);
            search.set("today", localToday());
        }
        return search.toString();
    }, [tab, state, sort, folder, due]);

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

    // Someone changed a shared recording: its tasks may have moved.
    useOrgEvents(true, () => void load());

    // Per row: the version the server last returned, and the write in
    // flight, so quick changes to one row go one after another.
    const versions = useRef(new Map<string, number>());
    const pending = useRef(new Map<string, Promise<void>>());

    const update = (
        task: TaskListItem,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskListItem>,
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
                await load();
            })
            .finally(() => {
                if (pending.current.get(task.id) === run) {
                    pending.current.delete(task.id);
                }
            });
        pending.current.set(task.id, run);
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
                        <SelectItem value="open">{i18n("Open")}</SelectItem>
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
                    {tasks.map((task) => {
                        const done = task.status === "done";
                        const dropped = task.status === "dropped";
                        const href = `/dashboard?recording=${encodeURIComponent(task.recording.id)}${task.recording.view === "org" ? "&view=org" : ""}`;
                        return (
                            <li
                                key={task.id}
                                className="flex items-start gap-3 p-3 text-sm"
                            >
                                <input
                                    type="checkbox"
                                    className="mt-1 size-4 shrink-0 accent-primary"
                                    checked={done}
                                    disabled={!task.canClose || dropped}
                                    onChange={(event) => {
                                        const status = event.target.checked
                                            ? "done"
                                            : "open";
                                        update(task, { status }, { status });
                                    }}
                                    aria-label={i18n("Done")}
                                />
                                <div className="min-w-0 flex-1 space-y-1.5">
                                    <p
                                        className={cn(
                                            (done || dropped) &&
                                                "text-muted-foreground line-through",
                                        )}
                                    >
                                        {task.text}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                        {(tab === "tracked" ||
                                            task.canEdit) && (
                                            <AssigneePicker
                                                value={task.assignee}
                                                hint={task.assigneeHint}
                                                speakers={[]}
                                                organizationOnly={
                                                    task.recording.view ===
                                                    "org"
                                                }
                                                disabled={
                                                    !task.canEdit || dropped
                                                }
                                                onChange={(person) =>
                                                    update(
                                                        task,
                                                        {
                                                            assigneePersonId:
                                                                person?.personId ??
                                                                null,
                                                        },
                                                        {
                                                            assignee: person,
                                                            assigneeHint: null,
                                                        },
                                                    )
                                                }
                                            />
                                        )}
                                        <DueDateField
                                            value={task.dueDate}
                                            overdue={task.status === "open"}
                                            disabled={!task.canEdit || dropped}
                                            onChange={(dueDate) =>
                                                update(
                                                    task,
                                                    { dueDate },
                                                    { dueDate },
                                                )
                                            }
                                        />
                                        <Link
                                            href={href}
                                            className="truncate hover:text-primary hover:underline"
                                        >
                                            {task.recording.title}
                                        </Link>
                                        <span>
                                            {format.dateTime(
                                                new Date(
                                                    task.recording.startTime,
                                                ),
                                                {
                                                    day: "numeric",
                                                    month: "short",
                                                    year: "numeric",
                                                },
                                            )}
                                        </span>
                                        {dropped && (
                                            <span className="rounded bg-muted px-1.5">
                                                {i18n("Dropped")}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
