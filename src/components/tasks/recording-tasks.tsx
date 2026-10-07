"use client";

import { Loader2, Plus } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import type { SpeakerChoice } from "@/components/tasks/assignee-picker";
import { TaskRow } from "@/components/tasks/task-row";
import type { RecordingTasksState } from "@/components/tasks/use-recording-tasks";
import { Button } from "@/components/ui/button";

interface RecordingTasksProps {
    state: RecordingTasksState;
    /** People attributed to the recording's speakers, offered first. */
    speakers: readonly SpeakerChoice[];
    /** The Organization view: assignees come from the Organization only. */
    organizationOnly: boolean;
    /** Play the recording from a moment, up to the turn's end. */
    onPlay?: (startMs: number) => void;
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
    onPlay,
    fallback,
    allowAdd = true,
}: RecordingTasksProps) {
    const i18n = useExtracted();
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
        <Button
            size="sm"
            variant="ghost"
            onClick={() => void state.add("open")}
        >
            <Plus className="mr-1 size-3.5" />
            {i18n("Add task")}
        </Button>
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
                        className="text-xs text-muted-foreground hover:text-foreground"
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
                            speakers={speakers}
                            organizationOnly={organizationOnly}
                            onPlay={onPlay}
                            onChange={(change, optimistic) =>
                                state.update(task, change, optimistic)
                            }
                        />
                    ))}
                </ul>
            )}
            {addButton}
        </section>
    );
}
