"use client";

import { ArrowDownWideNarrow, ListChecks, Loader2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { OwnTaskForm } from "@/components/tasks/own-task-form";
import { RoutedProposalsInbox } from "@/components/tasks/routed-proposals-inbox";
import {
    AddTaskTrigger,
    TaskAssigneeSelect,
    TaskStateSelect,
} from "@/components/tasks/task-list-controls";
import { TaskRow } from "@/components/tasks/task-row";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useTaskListData } from "@/hooks/use-task-list-data";
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
    const folderLabel = useFolderLabel();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const tab =
        params.get("tab") === "all"
            ? "all"
            : organization ||
                ["tracked", "followed"].includes(params.get("tab") ?? "")
              ? "followed"
              : "mine";
    const [addOpen, setAddOpen] = useState(false);
    const [addSaving, setAddSaving] = useState(false);
    const [addClicks, setAddClicks] = useState(0);
    const addTrigger = useRef<HTMLButtonElement>(null);
    const addRequest = params.get("add");
    useEffect(() => {
        setAddOpen(Boolean(addRequest));
    }, [addRequest]);
    const allOrganization = canCurate && params.get("organization") === "true";
    const state = params.get("state") ?? "open";
    const folder = params.get("folder") ?? ALL;
    const assignee = tab !== "mine" ? params.get("assignee") || ALL : ALL;
    const due = params.get("due") ?? ALL;
    const sort = params.get("sort") === "due" ? "due" : "created";

    const setParam = (key: string, value: string | null) => {
        const next = new URLSearchParams(params.toString());
        if (
            value === null ||
            (value === ALL && key !== "state" && key !== "tab")
        )
            next.delete(key);
        else next.set(key, value);
        const query = next.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    };
    const {
        tasks,
        reload,
        update,
        merge,
        onAdded,
        onReconciled,
        folders,
        selectedPrivate,
        sortedAssignees,
    } = useTaskListData({
        tab,
        state,
        folder,
        assignee,
        due,
        sort,
        allOrganization,
        // Opening the list is seeing what is new.
        markSeen: true,
    });

    const tabs = [
        ...(!organization ? [{ key: "mine", label: i18n("Mine") }] : []),
        { key: "followed", label: i18n("Followed") },
        { key: "all", label: i18n({ id: "tasks_scope_all", message: "All" }) },
    ];

    return (
        <div className="mx-auto max-w-4xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-xl font-semibold">
                        <ListChecks className="size-5 text-tasks" />
                        {i18n("Tasks")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {organization
                            ? i18n("Tasks from the Organization's recordings.")
                            : tab === "all"
                              ? i18n("All tasks you can see.")
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

                <TaskStateSelect
                    state={state}
                    onChange={(value) =>
                        setParam("state", value === "open" ? null : value)
                    }
                />
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
                {tab !== "mine" && (
                    <TaskAssigneeSelect
                        assignee={assignee}
                        assignees={sortedAssignees}
                        onChange={(value) => setParam("assignee", value)}
                    />
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
                {!organization && tab !== "followed" && (
                    <AddTaskTrigger
                        open={addOpen}
                        saving={addSaving}
                        triggerRef={addTrigger}
                        onOpen={() => {
                            setAddOpen(true);
                            setAddClicks((count) => count + 1);
                        }}
                    />
                )}
            </div>

            <ul className="divide-y rounded-lg border">
                {!organization && tab !== "followed" && (
                    <OwnTaskForm
                        open={addOpen}
                        focusRequest={`${addRequest ?? ""}:${addClicks}`}
                        triggerRef={addTrigger}
                        onSavingChange={setAddSaving}
                        folders={folders}
                        defaultFolderId={
                            selectedPrivate?.kind === "private" ||
                            selectedPrivate?.receivedFolder
                                ? null
                                : (selectedPrivate?.id ?? null)
                        }
                        onOpenChange={(open) => {
                            setAddOpen(open);
                            if (!open && addRequest) setParam("add", null);
                        }}
                        onReconciled={onReconciled}
                        onAdded={onAdded}
                    />
                )}
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
        </div>
    );
}
