"use client";

import { Lock, Plus } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { addOwnTask } from "@/components/tasks/task-api";
import { TaskFolderPicker } from "@/components/tasks/task-folder-picker";
import { folderDisplayPath } from "@/lib/folders/labels";
import type { TaskListItem } from "@/lib/tasks/tasks";
import type { RecordingFolder } from "@/types/folder";

/** The first row of Mine creates a private task. */
export function OwnTaskForm({
    open,
    onOpenChange,
    onAdded,
    onReconciled,
    folders = [],
    defaultFolderId = null,
    focusRequest,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (task: TaskListItem) => void;
    onReconciled: (temporaryId: string, task: TaskListItem | null) => void;
    folders?: RecordingFolder[];
    defaultFolderId?: string | null;
    focusRequest?: string | null;
}) {
    const i18n = useExtracted();
    const formId = useId();
    const nextId = useRef(0);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const restoreFocus = useRef(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        void focusRequest;
        if (open) inputRef.current?.focus();
        else if (restoreFocus.current) {
            triggerRef.current?.focus();
            restoreFocus.current = false;
        }
    }, [open, focusRequest]);
    const [text, setText] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [saving, setSaving] = useState(false);
    const [chosenFolder, setChosenFolder] = useState<{
        id: string | null;
    } | null>(null);
    const folderId = chosenFolder ? chosenFolder.id : defaultFolderId;
    const close = () => {
        restoreFocus.current = true;
        onOpenChange(false);
    };
    return (
        <li className="p-3 text-sm">
            {!open ? (
                <button
                    ref={triggerRef}
                    type="button"
                    className="flex w-full items-center gap-2 text-left aria-disabled:opacity-50"
                    aria-disabled={saving}
                    onClick={() => {
                        if (!saving) onOpenChange(true);
                    }}
                >
                    <Plus className="size-4" />
                    {i18n("Add task")}
                </button>
            ) : (
                <form
                    className="space-y-2"
                    onKeyDown={(event) => {
                        if (event.key === "Escape" && !event.defaultPrevented) {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                        }
                    }}
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!text.trim() || saving) return;
                        const temporaryId = `pending-${formId}-${++nextId.current}`;
                        const now = new Date().toISOString();
                        const folder = folders.find(
                            (entry) => entry.id === folderId,
                        );
                        const optimistic: TaskListItem = {
                            id: temporaryId,
                            recordingId: null,
                            evidenceItemId: null,
                            evidenceItemKind: "audio",
                            evidenceAudioAvailable: false,
                            status: "open",
                            text: text.trim(),
                            assignee: null,
                            assigneeHasEmail: false,
                            assigneeHint: null,
                            assigneeCheck: false,
                            dueDate: dueDate || null,
                            duePhrase: null,
                            quote: null,
                            evidenceStartMs: null,
                            evidenceText: null,
                            evidenceProvenance: null,
                            source: "personal",
                            own: true,
                            folder: folder
                                ? {
                                      id: folder.id,
                                      name: folder.name,
                                      path: folderDisplayPath(
                                          folder,
                                          new Map(
                                              folders.map((entry) => [
                                                  entry.id,
                                                  entry,
                                              ]),
                                          ),
                                          (entry) => entry.name,
                                      ),
                                  }
                                : null,
                            note: null,
                            noteBy: null,
                            noteUpdatedAt: null,
                            following: false,
                            automaticFollow: false,
                            canFollow: false,
                            canMerge: false,
                            canEdit: false,
                            canClose: false,
                            canUndoMatch: false,
                            ticked: true,
                            version: 0,
                            createdAt: now,
                            acceptedAt: now,
                            statusChangedAt: null,
                            recording: null,
                            evidence: null,
                            visibleMentionQuotes: [],
                        };
                        setSaving(true);
                        onAdded(optimistic);
                        close();
                        void addOwnTask(text, dueDate || null, folderId)
                            .then((task) => {
                                onReconciled(temporaryId, task);
                                setText("");
                                setDueDate("");
                                setChosenFolder(null);
                            })
                            .catch((error: unknown) => {
                                onReconciled(temporaryId, null);
                                toast.error(
                                    error instanceof Error && error.message
                                        ? error.message
                                        : i18n("Could not save the task"),
                                );
                            })
                            .finally(() => setSaving(false));
                    }}
                >
                    <textarea
                        ref={inputRef}
                        required
                        disabled={saving}
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
                            disabled={saving}
                            aria-label={i18n("Due date")}
                            value={dueDate}
                            onChange={(event) => setDueDate(event.target.value)}
                            className="rounded-md border bg-background px-2 py-1"
                        />
                        <button
                            type="button"
                            className="ml-auto"
                            onClick={close}
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
