"use client";

import { ArrowUpRight, RotateCcw, Trash2, Unlink } from "lucide-react";
import Link from "next/link";
import { useExtracted, useFormatter } from "next-intl";
import { toast } from "sonner";
import { PlayAtButton } from "@/components/playback/play-at-button";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import { MergeTaskPicker } from "@/components/tasks/merge-task-picker";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { DueDateField, TaskTextInput } from "@/components/tasks/task-fields";
import type { TaskRowChange } from "@/components/tasks/use-recording-tasks";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TaskListItem, TaskView } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";

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
    ) => Promise<{ ownerNotified?: boolean } | boolean>;
    onUndoMatch?: () => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const done = task.status === "done";
    const dropped = task.status === "dropped";
    const editable = task.canEdit && !dropped;
    let closeReason: string | null = null;
    if (!task.canClose && !dropped) {
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
            }}
            aria-label={i18n("Done")}
        />
    );

    return (
        <li className="group flex items-start gap-3 p-3 text-sm">
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
                            (done || dropped) &&
                                "text-muted-foreground line-through",
                        )}
                    >
                        {task.text}
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {showAssignee && (
                        <AssigneePicker
                            value={task.assignee}
                            hint={task.assigneeHint}
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
                    )}
                    <DueDateField
                        value={task.dueDate}
                        overdue={task.status === "open"}
                        disabled={!editable}
                        onChange={(dueDate) =>
                            onChange({ dueDate }, { dueDate })
                        }
                    />
                    {evidence && (
                        <>
                            <Link
                                href={`/dashboard?recording=${encodeURIComponent(evidence.id)}${evidence.view === "org" ? "&view=org" : ""}${task.evidenceStartMs !== null && evidence.audioAvailable ? `&playFrom=${task.evidenceStartMs}` : ""}`}
                                className="truncate hover:text-primary hover:underline"
                            >
                                <ArrowUpRight
                                    className="mr-1 inline size-3"
                                    aria-hidden="true"
                                />
                                {evidence.title}
                            </Link>
                            <span>
                                {format.dateTime(new Date(evidence.startTime), {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                })}
                            </span>
                        </>
                    )}
                    {!evidence &&
                        task.evidenceItemId === currentItemId &&
                        task.evidenceItemKind === "audio" &&
                        task.evidenceStartMs !== null &&
                        task.evidenceAudioAvailable && (
                            <PlayAtButton
                                ms={task.evidenceStartMs}
                                label={i18n("Where it was said")}
                                playLabel={i18n("Play where it was said")}
                                title={task.quote ?? undefined}
                            />
                        )}
                    {!evidence &&
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
                    {recording &&
                        task.status === "open" &&
                        task.canEdit &&
                        onMerge && (
                            <MergeTaskPicker
                                itemId={recording.id}
                                sourceTaskId={task.id}
                                onMerge={onMerge}
                            />
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
                            className={cn(
                                "ml-auto inline-flex items-center gap-1 hover:text-foreground",
                                !dropped &&
                                    "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
                            )}
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
        </li>
    );
}
