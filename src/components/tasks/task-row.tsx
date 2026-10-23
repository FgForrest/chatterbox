"use client";

import "./task-row.css";

import {
    ArrowUpRight,
    Eye,
    Lock,
    Mail,
    MessageSquare,
    Mic,
    RotateCcw,
    Trash2,
    Unlink,
} from "lucide-react";
import Link from "next/link";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PlayAtButton } from "@/components/playback/play-at-button";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import { MergeTaskPicker } from "@/components/tasks/merge-task-picker";
import {
    announceTasksChanged,
    setTaskFollow,
    type TaskMergeOptions,
} from "@/components/tasks/task-api";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { DueDateField, TaskTextInput } from "@/components/tasks/task-fields";
import { TaskFolderPicker } from "@/components/tasks/task-folder-picker";
import type { TaskRowChange } from "@/components/tasks/use-recording-tasks";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TaskListItem, TaskView } from "@/lib/tasks/tasks";
import { formatClock } from "@/lib/topics/timeline";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";

/**
 * An accepted task as the Tasks page lists it, and its recording too: done
 * box, text (editable for whoever may change it), who and by when, where it
 * came from, and dropping it. Rows go in a `divide-y` bordered list.
 */
export function TaskRow({
    task,
    recording,
    evidence,
    currentItemId,
    showAssignee = true,
    speakers = [],
    organizationOnly,
    onChange,
    onMerge,
    onUndoMatch,
    onFollow,
    folders = [],
}: {
    task: TaskView;
    /** The recording it came from, on the Tasks page. */
    recording?: TaskListItem["recording"];
    /** The latest visible item that evidences the task. */
    evidence?: TaskListItem["evidence"];
    currentItemId?: string;
    showAssignee?: boolean;
    speakers?: readonly SpeakerChoice[];
    organizationOnly: boolean;
    onChange: TaskRowChange;
    onMerge?: (
        targetTaskId: string,
        options?: TaskMergeOptions,
    ) => Promise<{ ownerNotified?: boolean } | boolean>;
    onUndoMatch?: () => void;
    onFollow?: () => void;
    folders?: RecordingFolder[];
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [noteOpen, setNoteOpen] = useState(false);
    const noteInput = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (noteOpen) noteInput.current?.focus();
    }, [noteOpen]);
    const [noteDraft, setNoteDraft] = useState(task.note ?? "");
    const [following, setFollowing] = useState(task.following);
    useEffect(() => setFollowing(task.following), [task.following]);
    useEffect(() => setNoteDraft(task.note ?? ""), [task.note]);
    const own = task.source === "personal";
    const pageRow = recording !== undefined || evidence !== undefined || own;
    const done = task.status === "done";
    const dropped = task.status === "dropped";
    const editable = task.canEdit && !dropped;
    let closeReason: string | null = null;
    if (task.receivedOwnerName && !task.canClose && !dropped) {
        closeReason = i18n("Only {owner} can edit this task.", {
            owner: task.receivedOwnerName,
        });
    } else if (!task.canClose && !dropped) {
        if (!task.assignee) {
            closeReason = i18n(
                "Nobody is assigned yet. Only the recording's owner or a curator can mark it done.",
            );
        } else if (task.assigneeHasEmail) {
            closeReason = i18n(
                "Assigned to {name}. Only they, the recording's owner or a curator can mark it done.",
                { name: task.assignee.name },
            );
        } else {
            closeReason = i18n(
                "Assigned to {name}, who has no email in the Almanac, so the task is on nobody's list.",
                { name: task.assignee.name },
            );
        }
    }
    const checkbox = (
        <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            checked={done}
            disabled={dropped}
            aria-disabled={closeReason ? true : undefined}
            onClick={() => {
                if (closeReason) {
                    toast.error(closeReason);
                }
            }}
            onKeyDown={(event) => {
                if (closeReason && event.key === " ") {
                    event.preventDefault();
                    toast.error(closeReason);
                }
            }}
            onChange={(event) => {
                if (!task.canClose || dropped) return;
                const status = event.target.checked ? "done" : "open";
                onChange({ status }, { status });
                if (status === "done") setNoteOpen(true);
            }}
            aria-label={i18n("Done")}
        />
    );

    return (
        <li className="task-row group flex items-start gap-3 p-3 text-sm">
            {closeReason ? (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>{checkbox}</TooltipTrigger>
                        <TooltipContent className="max-w-72">
                            {closeReason}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            ) : (
                checkbox
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
                {editable ? (
                    <TaskTextInput
                        text={task.text}
                        onSave={(text) => onChange({ text }, { text })}
                        className={cn(
                            "-mx-1 w-[calc(100%+0.5rem)]",
                            done && "text-muted-foreground line-through",
                        )}
                    />
                ) : (
                    <p
                        className={cn(
                            "whitespace-pre-wrap",
                            (done || dropped) &&
                                "text-muted-foreground line-through",
                        )}
                    >
                        {task.text}
                    </p>
                )}
                {task.receivedOwnerName && !editable && (
                    <p className="text-xs text-muted-foreground">
                        {i18n("Only {owner} can edit this task.", {
                            owner: task.receivedOwnerName,
                        })}
                    </p>
                )}
                {pageRow && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {own ? (
                            <span>
                                {i18n("Own task")} ·{" "}
                                {format.dateTime(new Date(task.createdAt), {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                })}
                            </span>
                        ) : (
                            <>
                                {" "}
                                {evidence && (
                                    <Link
                                        href={`/dashboard?recording=${encodeURIComponent(evidence.id)}${evidence.view !== "private" ? `&view=${evidence.view}` : ""}${task.evidenceStartMs !== null && evidence.audioAvailable ? `&playFrom=${task.evidenceStartMs}` : ""}`}
                                        className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 hover:text-primary"
                                    >
                                        {evidence.kind === "mail" ? (
                                            <Mail className="size-3" />
                                        ) : (
                                            <Mic className="size-3" />
                                        )}
                                        <ArrowUpRight
                                            className="mr-1 inline size-3"
                                            aria-hidden="true"
                                        />
                                        <span>{evidence.title}</span>
                                        {" · "}
                                        <span>
                                            {format.dateTime(
                                                new Date(evidence.startTime),
                                                {
                                                    day: "numeric",
                                                    month: "short",
                                                    year: "numeric",
                                                },
                                            )}
                                        </span>
                                    </Link>
                                )}
                            </>
                        )}
                        {own && task.canEdit && (
                            <>
                                <span aria-hidden>·</span>
                                <TaskFolderPicker
                                    folders={folders}
                                    value={task.folder?.id ?? null}
                                    fallbackName={task.folder?.name}
                                    row
                                    onChange={(folder) =>
                                        onChange(
                                            { folderId: folder?.id ?? null },
                                            { folder },
                                        )
                                    }
                                />
                            </>
                        )}
                        {task.automaticFollow && (
                            <span>{i18n("from your recording")}</span>
                        )}
                    </div>
                )}
                <div className="task-row-pills flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {own ? (
                        <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1">
                            <Lock className="size-3" />
                            {i18n("Only you")}
                        </span>
                    ) : (
                        showAssignee && (
                            <AssigneePicker
                                value={task.assignee}
                                hint={task.assigneeHint}
                                check={task.assigneeCheck}
                                speakers={speakers}
                                organizationOnly={organizationOnly}
                                disabled={!editable}
                                onChange={(person) =>
                                    onChange(
                                        {
                                            assigneePersonId:
                                                person?.personId ?? null,
                                        },
                                        {
                                            assignee: person,
                                            assigneeHint: null,
                                            assigneeCheck: false,
                                        },
                                    )
                                }
                            />
                        )
                    )}
                    <DueDateField
                        value={task.dueDate}
                        overdue={task.status === "open"}
                        disabled={!editable}
                        onChange={(dueDate) =>
                            onChange({ dueDate }, { dueDate })
                        }
                    />
                    {!pageRow &&
                        task.evidenceItemId === currentItemId &&
                        task.evidenceItemKind === "audio" &&
                        task.evidenceStartMs !== null &&
                        (task.evidenceAudioAvailable ? (
                            <PlayAtButton
                                ms={task.evidenceStartMs}
                                label={i18n("Where it was said")}
                                playLabel={i18n("Play where it was said")}
                                title={task.quote ?? undefined}
                            />
                        ) : (
                            <span
                                className="rounded-md border px-2 py-1 tabular-nums"
                                title={task.quote ?? undefined}
                            >
                                {formatClock(task.evidenceStartMs)}
                            </span>
                        ))}
                    {!pageRow &&
                        task.evidenceItemId &&
                        (task.evidenceItemId !== currentItemId ||
                            task.evidenceItemKind === "mail") && (
                            <TaskEvidenceLink
                                evidence={{
                                    itemId: task.evidenceItemId,
                                    itemKind: task.evidenceItemKind,
                                    audioAvailable: task.evidenceAudioAvailable,
                                    startMs: task.evidenceStartMs,
                                    text: task.evidenceText,
                                }}
                                quote={task.quote}
                                currentItemId={currentItemId}
                            />
                        )}
                    {dropped && (
                        <span className="rounded bg-muted px-1.5">
                            {i18n("Dropped")}
                        </span>
                    )}
                    <div className="task-row-actions ml-auto flex flex-wrap items-center justify-end gap-3">
                        {task.canClose && (
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                onClick={() => setNoteOpen(true)}
                            >
                                <MessageSquare className="size-3" />
                                {i18n("Note")}
                            </button>
                        )}
                        {(task.canMerge || task.canEdit) &&
                            task.status === "open" &&
                            onMerge && (
                                <MergeTaskPicker
                                    itemId={task.recordingId}
                                    sourceTaskId={task.id}
                                    taskVersion={task.version}
                                    inlineTrigger
                                    onMerge={onMerge}
                                />
                            )}
                        {task.canFollow && !own && (
                            <button
                                type="button"
                                aria-pressed={following}
                                title={
                                    following
                                        ? i18n("Stop following")
                                        : i18n("Follow")
                                }
                                className={cn(
                                    "inline-flex items-center gap-1 hover:text-foreground",
                                    following && "task-following text-primary",
                                )}
                                onClick={() => {
                                    const next = !following;
                                    setFollowing(next);
                                    void setTaskFollow(task.id, next)
                                        .then(() => {
                                            announceTasksChanged();
                                            onFollow?.();
                                        })
                                        .catch(() => {
                                            setFollowing(!next);
                                            toast.error(
                                                i18n("Could not save the task"),
                                            );
                                        });
                                }}
                            >
                                <Eye className="size-3" />
                                {following ? i18n("Following") : i18n("Follow")}
                            </button>
                        )}
                        {task.canUndoMatch && onUndoMatch && (
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                onClick={onUndoMatch}
                            >
                                <Unlink className="size-3" />
                                {i18n("Undo match")}
                            </button>
                        )}
                        {task.canEdit && (
                            <button
                                type="button"
                                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                                onClick={() => {
                                    const status = dropped ? "open" : "dropped";
                                    onChange({ status }, { status });
                                }}
                            >
                                {dropped ? (
                                    <>
                                        <RotateCcw className="size-3" />
                                        {i18n("Restore")}
                                    </>
                                ) : (
                                    <>
                                        <Trash2 className="size-3" />
                                        {i18n("Drop")}
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>
                {task.note && !noteOpen && (
                    <div className="flex gap-2 border-l-2 border-primary/30 pl-3">
                        <MessageSquare className="mt-1 size-3 shrink-0" />
                        <div>
                            <p className="whitespace-pre-wrap">{task.note}</p>
                            <p className="text-xs text-muted-foreground">
                                {task.noteBy?.name ?? i18n("Unknown author")}
                                {task.noteUpdatedAt && (
                                    <>
                                        {" "}
                                        ·{" "}
                                        {format.dateTime(
                                            new Date(task.noteUpdatedAt),
                                            {
                                                dateStyle: "medium",
                                                timeStyle: "short",
                                            },
                                        )}
                                    </>
                                )}
                            </p>
                        </div>
                    </div>
                )}
                {noteOpen && task.canClose && (
                    <div className="space-y-2">
                        <textarea
                            ref={noteInput}
                            aria-label={i18n("Note")}
                            maxLength={2000}
                            value={noteDraft}
                            onChange={(event) =>
                                setNoteDraft(event.target.value)
                            }
                            className="min-h-20 w-full rounded-md border bg-background p-2"
                        />
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>
                                {i18n(
                                    "One note per task. Everyone who sees the task can read it.",
                                )}
                            </span>
                            <button
                                type="button"
                                className="ml-auto"
                                onClick={() => setNoteOpen(false)}
                            >
                                {i18n("Skip")}
                            </button>
                            <button
                                type="button"
                                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
                                onClick={() => {
                                    const note = noteDraft.trim() || null;
                                    onChange({ note }, { note });
                                    setNoteOpen(false);
                                }}
                            >
                                {i18n("Save note")}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </li>
    );
}
