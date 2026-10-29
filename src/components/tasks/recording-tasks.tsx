"use client";

import { Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import { useOptionalConfirm } from "@/components/confirm-dialog";
import { AddTaskButton } from "@/components/tasks/add-task-button";
import type { SpeakerChoice } from "@/components/tasks/assignee-picker";
import { mergeTaskIntoTarget } from "@/components/tasks/task-api";
import { useTaskMergeFailure } from "@/components/tasks/task-merge-feedback";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";

interface RecordingTasksProps {
    state: RecordingTasksState;
    /** People attributed to the recording's speakers, offered first. */
    speakers: readonly SpeakerChoice[];
    /** The Organization view: assignees come from the Organization only. */
    organizationOnly: boolean;
    /** Shown when the recording has no tasks: the summary's own list. */
    fallback: ReactNode;
    /** Offer adding tasks by hand; not without a summary they would die with. */
    allowAdd?: boolean;
}

/**
 * The recording's accepted tasks under its summary, listed as the Tasks
 * page lists them; whoever may close one ticks it done there. Proposals
 * are reviewed in `TaskReviewLink`'s dialog, not here.
 */
export function RecordingTasks({
    state,
    speakers,
    organizationOnly,
    fallback,
    allowAdd = true,
}: RecordingTasksProps) {
    const i18n = useExtracted();
    const showMergeFailure = useTaskMergeFailure();
    const confirm = useOptionalConfirm();
    const [showDropped, setShowDropped] = useState(false);
    const { data, failed, reviewing } = state;

    if (failed) return <>{fallback}</>;
    if (!data) {
        return (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {i18n("Loading tasks…")}
            </p>
        );
    }

    const dropped = data.tasks.filter((task) => task.status === "dropped");
    const shown = data.tasks.filter(
        (task) => showDropped || task.status !== "dropped",
    );
    // Adding by hand waits while proposals do: the review adds them.
    const canAdd = data.canEdit && allowAdd && !reviewing;
    const addButton = canAdd && (
        <AddTaskButton onClick={() => void state.add("open")} />
    );

    // No tasks: the summary's own list, as before tasks, unless a review
    // already said what its items were or is about to.
    if (data.tasks.length === 0) {
        if (reviewing) return null;
        return (
            <div className="space-y-2">
                {data.reviewed ? null : fallback}
                {addButton}
            </div>
        );
    }

    return (
        <section aria-label={i18n("Tasks")} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{i18n("Tasks")}</h4>
                {dropped.length > 0 && (
                    <button
                        type="button"
                        aria-expanded={showDropped}
                        className="rounded px-1 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setShowDropped(!showDropped)}
                    >
                        {showDropped
                            ? i18n("Hide dropped")
                            : i18n("Show dropped ({count})", {
                                  count: String(dropped.length),
                              })}
                    </button>
                )}
            </div>
            {shown.length > 0 && (
                <ul className="divide-y rounded-lg border">
                    {shown.map((task) => (
                        <TaskRow
                            key={task.id}
                            task={task}
                            currentItemId={state.itemId}
                            speakers={speakers}
                            organizationOnly={organizationOnly}
                            onChange={(change, optimistic) =>
                                state.update(task, change, optimistic)
                            }
                            onMerge={async (targetTaskId, options) => {
                                try {
                                    const result = await mergeTaskIntoTarget(
                                        task.id,
                                        targetTaskId,
                                        options,
                                    );
                                    await state.refresh?.();
                                    return {
                                        ownerNotified:
                                            result.mergeOwnerNotified,
                                    };
                                } catch (error) {
                                    showMergeFailure(error);
                                    return false;
                                }
                            }}
                            onUndoMatch={
                                task.canUndoMatch
                                    ? () => {
                                          if (!confirm) {
                                              void state.undoMatch(task);
                                              return;
                                          }
                                          void confirm({
                                              title: i18n(
                                                  "Undo this task match?",
                                              ),
                                              description: i18n(
                                                  "This removes the link from this item. Changes already applied to the task stay.",
                                              ),
                                              confirmLabel: i18n("Undo match"),
                                              pendingLabel: i18n("Undoing…"),
                                              onConfirm: () =>
                                                  state.undoMatch(task),
                                          });
                                      }
                                    : undefined
                            }
                        />
                    ))}
                </ul>
            )}
            {addButton}
        </section>
    );
}
