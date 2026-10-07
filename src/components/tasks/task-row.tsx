"use client";

import { Play, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useExtracted, useFormatter } from "next-intl";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import { DueDateField, TaskTextInput } from "@/components/tasks/task-fields";
import type { TaskRowChange } from "@/components/tasks/use-recording-tasks";
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
    showAssignee = true,
    speakers = [],
    organizationOnly,
    onPlay,
    onChange,
}: {
    task: TaskView;
    /** The recording it came from, on the Tasks page. */
    recording?: TaskListItem["recording"];
    showAssignee?: boolean;
    speakers?: readonly SpeakerChoice[];
    organizationOnly: boolean;
    /** Play the recording where the task was said. */
    onPlay?: (startMs: number) => void;
    onChange: TaskRowChange;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const done = task.status === "done";
    const dropped = task.status === "dropped";
    const editable = task.canEdit && !dropped;

    return (
        <li className="group flex items-start gap-3 p-3 text-sm">
            <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-primary"
                checked={done}
                disabled={!task.canClose || dropped}
                onChange={(event) => {
                    const status = event.target.checked ? "done" : "open";
                    onChange({ status }, { status });
                }}
                aria-label={i18n("Done")}
            />
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
                    {recording && (
                        <>
                            <Link
                                href={`/dashboard?recording=${encodeURIComponent(recording.id)}${recording.view === "org" ? "&view=org" : ""}`}
                                className="truncate hover:text-primary hover:underline"
                            >
                                {recording.title}
                            </Link>
                            <span>
                                {format.dateTime(
                                    new Date(recording.startTime),
                                    {
                                        day: "numeric",
                                        month: "short",
                                        year: "numeric",
                                    },
                                )}
                            </span>
                        </>
                    )}
                    {task.evidenceStartMs !== null && onPlay && (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-primary"
                            title={task.quote ?? undefined}
                            onClick={() =>
                                onPlay(task.evidenceStartMs as number)
                            }
                        >
                            <Play className="size-3" />
                            {i18n("Where it was said")}
                        </button>
                    )}
                    {dropped && (
                        <span className="rounded bg-muted px-1.5">
                            {i18n("Dropped")}
                        </span>
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
