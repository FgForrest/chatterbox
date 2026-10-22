"use client";

import { Lock, Plus } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { addOwnTask } from "@/components/tasks/task-api";
import { TaskFolderPicker } from "@/components/tasks/task-folder-picker";
import type { TaskListItem } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

/** The first row of Mine creates a private task. */
export function OwnTaskForm({
    open,
    onOpenChange,
    onAdded,
    folders = [],
    defaultFolderId = null,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (task: TaskListItem) => void;
    folders?: RecordingFolder[];
    defaultFolderId?: string | null;
}) {
    const i18n = useExtracted();
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);
    const [text, setText] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [saving, setSaving] = useState(false);
    const [chosenFolder, setChosenFolder] = useState<{
        id: string | null;
    } | null>(null);
    const folderId = chosenFolder ? chosenFolder.id : defaultFolderId;
    return (
        <li className="p-3 text-sm">
            {!open ? (
                <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    onClick={() => onOpenChange(true)}
                >
                    <Plus className="size-4" />
                    {i18n("Add task")}
                </button>
            ) : (
                <form
                    className="space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!text.trim() || saving) return;
                        setSaving(true);
                        void addOwnTask(text, dueDate || null, folderId)
                            .then((task) => {
                                onAdded(task);
                                setText("");
                                setDueDate("");
                                setChosenFolder(null);
                                onOpenChange(false);
                            })
                            .catch(() =>
                                toast.error(i18n("Could not save the task")),
                            )
                            .finally(() => setSaving(false));
                    }}
                >
                    <textarea
                        ref={inputRef}
                        required
                        maxLength={2000}
                        aria-label={i18n("Task text")}
                        placeholder={i18n("What needs doing?")}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        className="w-full rounded-md border bg-background p-2"
                    />
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
                            <Lock className="size-3" />
                            {i18n("Only you")}
                        </span>
                        <TaskFolderPicker
                            folders={folders}
                            value={folderId}
                            disabled={saving}
                            onChange={(folder) =>
                                setChosenFolder({ id: folder?.id ?? null })
                            }
                        />
                        <input
                            type="date"
                            aria-label={i18n("Due date")}
                            value={dueDate}
                            onChange={(event) => setDueDate(event.target.value)}
                            className="rounded-md border bg-background px-2 py-1"
                        />
                        <button
                            type="button"
                            className="ml-auto"
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </button>
                        <button
                            disabled={saving || !text.trim()}
                            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
                            type="submit"
                        >
                            {i18n("Add")}
                        </button>
                    </div>
                </form>
            )}
        </li>
    );
}
