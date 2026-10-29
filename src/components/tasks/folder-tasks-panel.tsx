"use client";

import { ArrowLeft, ArrowUpRight, ListChecks, Loader2 } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { useRef, useState } from "react";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";
import { OwnTaskForm } from "@/components/tasks/own-task-form";
import {
    AddTaskTrigger,
    TaskAssigneeSelect,
    TaskStateSelect,
} from "@/components/tasks/task-list-controls";
import { TaskRow } from "@/components/tasks/task-row";
import { Button } from "@/components/ui/button";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useTaskListData } from "@/hooks/use-task-list-data";
import { folderDisplayPath } from "@/lib/folders/labels";
import type { TaskListItem } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

/** Folder task desk, using the Tasks page's queries, editors and mutations. */
export function FolderTasksPanel({
    folder,
    organization,
    isOrgAccount = false,
    onBack,
}: {
    folder: RecordingFolder;
    organization: FolderOrganization;
    isOrgAccount?: boolean;
    onBack: () => void;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const [tab, setTab] = useState<"mine" | "followed" | "all">("all");
    const [state, setState] = useState("open");
    const [assignee, setAssignee] = useState("all");
    const [addOpen, setAddOpen] = useState(false);
    const [addSaving, setAddSaving] = useState(false);
    const addTrigger = useRef<HTMLButtonElement>(null);
    const folders = organization.folders;
    const ordered: RecordingFolder[] = [];
    const visit = (entry: RecordingFolder) => {
        if (ordered.some((previous) => previous.id === entry.id)) return;
        ordered.push(entry);
        for (const child of folders
            .filter((child) => child.parentId === entry.id)
            .sort(
                (a, b) =>
                    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
            ))
            visit(child);
    };
    visit(folder);
    const subtree = new Set(ordered.map((entry) => entry.id));
    const assignments = organization.assignments.filter((assignment) =>
        subtree.has(assignment.folderId),
    );
    const revision = JSON.stringify([
        ordered.map((entry) => [entry.id, entry.parentId]),
        assignments
            .map((assignment) => [assignment.folderId, assignment.recordingId])
            .sort(
                (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
            ),
    ]);
    const {
        tasks,
        error,
        reload,
        update,
        merge,
        onAdded,
        onReconciled,
        selectedPrivate,
        sortedAssignees,
        openCount,
    } = useTaskListData({
        tab,
        state,
        folder: folder.id,
        assignee: tab === "mine" ? "all" : assignee,
        initialFolders: folders,
        countOpen: true,
        revision,
    });
    const canAdd = !isOrgAccount && tab !== "followed";
    const byId = new Map(folders.map((entry) => [entry.id, entry]));
    const placements = new Map<string, Set<string>>();
    for (const assignment of assignments) {
        const ids = placements.get(assignment.recordingId) ?? new Set<string>();
        ids.add(assignment.folderId);
        placements.set(assignment.recordingId, ids);
    }
    const groups = new Map<string, TaskListItem[]>();
    for (const task of tasks ?? []) {
        const group = task.own
            ? ordered.find((entry) => entry.id === task.folder?.id)
            : ordered.find(
                  (entry) =>
                      task.recording &&
                      placements.get(task.recording.id)?.has(entry.id),
              );
        const id = group?.id ?? folder.id;
        groups.set(id, [...(groups.get(id) ?? []), task]);
    }
    const tabs = [
        ...(!isOrgAccount
            ? [{ key: "mine" as const, label: i18n("Mine") }]
            : []),
        { key: "followed" as const, label: i18n("Followed") },
        {
            key: "all" as const,
            label: i18n({ id: "tasks_scope_all", message: "All" }),
        },
    ];
    return (
        <section
            aria-label={i18n("Folder tasks")}
            className="min-w-0 rounded-lg border bg-card lg:sticky lg:top-20 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto"
        >
            <div className="space-y-3 p-4">
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <ArrowLeft className="size-4" />
                    {i18n("Back")}
                </Button>
                <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="flex items-center gap-2 text-base font-semibold">
                            <ListChecks className="size-4 shrink-0 text-tasks" />
                            {i18n("Tasks in {folder}", {
                                folder: label(folder),
                            })}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {ordered.length > 1 && (
                                <>{i18n("Including subfolders")} · </>
                            )}
                            {openCount === null
                                ? i18n("Loading…")
                                : i18n(
                                      "{count, plural, one {# open} other {# open}}",
                                      { count: openCount },
                                  )}
                        </p>
                    </div>
                    <Link
                        href={`/tasks?${new URLSearchParams({ folder: folder.id, tab })}`}
                        className="inline-flex items-center gap-1 text-sm text-tasks hover:underline"
                    >
                        {i18n("Open in Tasks")}
                        <ArrowUpRight className="size-3.5" />
                    </Link>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <nav
                        aria-label={i18n("Task lists")}
                        className="inline-flex rounded-lg bg-muted/70 p-1"
                    >
                        {tabs.map((entry) => (
                            <button
                                key={entry.key}
                                type="button"
                                aria-pressed={tab === entry.key}
                                onClick={() => setTab(entry.key)}
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
                    <TaskStateSelect state={state} onChange={setState} />
                    {tab !== "mine" && (
                        <TaskAssigneeSelect
                            assignee={assignee}
                            assignees={sortedAssignees}
                            onChange={setAssignee}
                        />
                    )}
                    {canAdd && (
                        <span className="ml-auto">
                            <AddTaskTrigger
                                open={addOpen}
                                saving={addSaving}
                                triggerRef={addTrigger}
                                onOpen={() => setAddOpen(true)}
                            />
                        </span>
                    )}
                </div>
            </div>
            <ul className="divide-y border-t">
                {canAdd && (
                    <OwnTaskForm
                        open={addOpen}
                        onOpenChange={setAddOpen}
                        triggerRef={addTrigger}
                        onSavingChange={setAddSaving}
                        folders={folders}
                        defaultFolderId={
                            selectedPrivate?.kind === "private" ||
                            selectedPrivate?.receivedFolder
                                ? null
                                : (selectedPrivate?.id ?? null)
                        }
                        onAdded={onAdded}
                        onReconciled={onReconciled}
                    />
                )}
                {error ? (
                    <li className="space-y-2 p-4" role="alert">
                        <p>{i18n("Could not load your tasks")}</p>
                        <Button variant="outline" onClick={() => void reload()}>
                            {i18n("Try again")}
                        </Button>
                    </li>
                ) : tasks === null ? (
                    <li className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {i18n("Loading tasks…")}
                    </li>
                ) : tasks.length === 0 ? (
                    <li className="space-y-2 p-8 text-center text-sm text-muted-foreground">
                        <p>{i18n("No tasks in this folder")}</p>
                        {canAdd && !addOpen && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setAddOpen(true)}
                            >
                                {i18n("Add task")}
                            </Button>
                        )}
                    </li>
                ) : (
                    ordered
                        .filter((entry) => groups.has(entry.id))
                        .map((entry) => (
                            <li key={entry.id}>
                                <h3 className="flex items-center gap-2 bg-muted/30 px-3 py-2 text-sm font-medium">
                                    <SharedFolderIcon folder={entry} />
                                    <span>
                                        {folderDisplayPath(entry, byId, label)}
                                    </span>
                                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                                        {groups.get(entry.id)?.length}
                                    </span>
                                </h3>
                                <ul className="divide-y">
                                    {groups.get(entry.id)?.map((task) => (
                                        <TaskRow
                                            key={task.id}
                                            task={task}
                                            folders={folders}
                                            recording={task.recording}
                                            evidence={task.evidence}
                                            showAssignee={
                                                tab !== "mine" || task.canEdit
                                            }
                                            organizationOnly={
                                                task.recording?.view === "org"
                                            }
                                            onChange={(change, optimistic) =>
                                                update(task, change, optimistic)
                                            }
                                            onMerge={(targetTaskId, options) =>
                                                merge(
                                                    task,
                                                    targetTaskId,
                                                    options,
                                                )
                                            }
                                            onFollow={() => void reload()}
                                        />
                                    ))}
                                </ul>
                            </li>
                        ))
                )}
            </ul>
        </section>
    );
}
