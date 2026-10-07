"use client";

import {
    Combine,
    ListChecks,
    Loader2,
    Play,
    Plus,
    RotateCcw,
    Trash2,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { announceLearnReviewsChanged } from "@/components/learn/review-events";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import {
    acceptTaskReview,
    addRecordingTask,
    announceTasksChanged,
    changeTask,
    fetchRecordingTasks,
    mergeTaskProposals,
    rejectTaskProposal,
    TaskRequestError,
    tickTaskUpdate,
} from "@/components/tasks/task-api";
import { DueDateField } from "@/components/tasks/task-fields";
import { Button } from "@/components/ui/button";
import type {
    RecordingTasks as RecordingTasksData,
    TaskChange,
    TaskUpdateView,
    TaskView,
} from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";

interface RecordingTasksProps {
    recordingId: string;
    /** People attributed to the recording's speakers, offered first. */
    speakers: readonly SpeakerChoice[];
    /** The Organization view: assignees come from the Organization only. */
    organizationOnly: boolean;
    /** Changes when a summary was made, so its proposals are read again. */
    reloadKey: string | number;
    /** Play the recording from a moment, up to the turn's end. */
    onPlay?: (startMs: number) => void;
    /** Shown when the recording has no tasks: the summary's own list. */
    fallback: ReactNode;
    /** Offer adding tasks by hand; not without a summary they would die with. */
    allowAdd?: boolean;
}

/**
 * The recording's tasks in its summary: for its reviewer first the
 * proposals of the last summary, to tick, correct, merge or drop, then
 * accept; below, the accepted tasks, which whoever may close them ticks
 * done. Writes to one row go one after another, each with the version the
 * last one returned.
 */
export function RecordingTasks({
    recordingId,
    speakers,
    organizationOnly,
    reloadKey,
    onPlay,
    fallback,
    allowAdd = true,
}: RecordingTasksProps) {
    const i18n = useExtracted();
    const [data, setData] = useState<RecordingTasksData | null>(null);
    const [failed, setFailed] = useState(false);
    const [merging, setMerging] = useState<string[] | null>(null);
    const [accepting, setAccepting] = useState(false);
    const [showDropped, setShowDropped] = useState(false);
    const dataRef = useRef<RecordingTasksData | null>(null);
    dataRef.current = data;
    // Per row: the version the server last returned, and the write in flight.
    const versions = useRef(new Map<string, number>());
    const pending = useRef(new Map<string, Promise<unknown>>());

    const reload = useCallback(async () => {
        try {
            const loaded = await fetchRecordingTasks(recordingId);
            versions.current = new Map([
                ...[...loaded.tasks, ...loaded.proposals].map(
                    (row) => [row.id, row.version] as const,
                ),
                ...loaded.updates.map(
                    (row) => [`update:${row.id}`, row.version] as const,
                ),
            ]);
            setData(loaded);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [recordingId]);

    useEffect(() => {
        void reloadKey;
        setData(null);
        void reload();
    }, [reload, reloadKey]);

    const patchRow = (id: string, patch: Partial<TaskView>) =>
        setData((current) =>
            current
                ? {
                      ...current,
                      tasks: current.tasks.map((row) =>
                          row.id === id ? { ...row, ...patch } : row,
                      ),
                      proposals: current.proposals.map((row) =>
                          row.id === id ? { ...row, ...patch } : row,
                      ),
                  }
                : current,
        );

    const failure = async (error: unknown) => {
        if (error instanceof TaskRequestError && error.conflict) {
            toast.error(i18n("Someone changed this meanwhile. Reloaded."));
        } else {
            toast.error(
                error instanceof Error && error.message
                    ? error.message
                    : i18n("Could not save the task"),
            );
        }
        await reload();
    };

    /** Queue a write on one row behind the writes before it. */
    const enqueue = (key: string, write: () => Promise<void>) => {
        const run = (pending.current.get(key) ?? Promise.resolve())
            .then(write)
            .catch(failure)
            .finally(() => {
                if (pending.current.get(key) === run) {
                    pending.current.delete(key);
                }
            });
        pending.current.set(key, run);
        return run;
    };

    /** Change one row optimistically, then keep what the server says. */
    const update = (
        task: TaskView,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => {
        patchRow(task.id, optimistic);
        void enqueue(task.id, async () => {
            const saved = await changeTask(task.id, {
                ...change,
                version: versions.current.get(task.id) ?? task.version,
            });
            versions.current.set(task.id, saved.version);
            // Later writes queued meanwhile keep their optimistic values.
            const { text, assignee, dueDate, ticked, status, ...rest } = saved;
            patchRow(task.id, {
                ...rest,
                ...(change.text !== undefined && { text }),
                ...(change.assigneePersonId !== undefined && { assignee }),
                ...(change.dueDate !== undefined && { dueDate }),
                ...(change.ticked !== undefined && { ticked }),
                ...(change.status !== undefined && { status }),
            });
            if (change.status) announceTasksChanged();
        });
    };

    const reject = (task: TaskView) => {
        setData((current) =>
            current
                ? {
                      ...current,
                      proposals: current.proposals.filter(
                          (row) => row.id !== task.id,
                      ),
                  }
                : current,
        );
        void enqueue(task.id, async () => {
            await rejectTaskProposal(
                task.id,
                versions.current.get(task.id) ?? task.version,
            );
        });
    };

    const add = async (status: "proposed" | "open") => {
        try {
            const task = await addRecordingTask(recordingId, {
                text: i18n("New task"),
                status,
            });
            versions.current.set(task.id, task.version);
            setData((current) => {
                if (!current) return current;
                if (status === "proposed") {
                    return {
                        ...current,
                        proposals: [...current.proposals, task],
                    };
                }
                return { ...current, tasks: [...current.tasks, task] };
            });
        } catch (error) {
            await failure(error);
        }
    };

    /** Select or unselect a proposal to merge, keeping the selection order. */
    const toggleMerging = (id: string) =>
        setMerging((current) => {
            const selected = current ?? [];
            return selected.includes(id)
                ? selected.filter((other) => other !== id)
                : [...selected, id];
        });

    const merge = async () => {
        if (!merging || merging.length < 2) return;
        const ids = merging;
        try {
            await Promise.all(pending.current.values());
            const kept = await mergeTaskProposals(recordingId, ids);
            versions.current.set(kept.id, kept.version);
            setMerging(null);
            setData((current) =>
                current
                    ? {
                          ...current,
                          proposals: current.proposals
                              .filter(
                                  (row) =>
                                      row.id === kept.id ||
                                      !ids.includes(row.id),
                              )
                              .map((row) => (row.id === kept.id ? kept : row)),
                      }
                    : current,
            );
        } catch (error) {
            await failure(error);
        }
    };

    const tickUpdate = (update: TaskUpdateView, ticked: boolean) => {
        const key = `update:${update.id}`;
        setData((current) =>
            current
                ? {
                      ...current,
                      updates: current.updates.map((row) =>
                          row.id === update.id ? { ...row, ticked } : row,
                      ),
                  }
                : current,
        );
        void enqueue(key, async () => {
            const version = versions.current.get(key) ?? update.version;
            await tickTaskUpdate(recordingId, update.id, ticked, version);
            versions.current.set(key, version + 1);
        });
    };

    const accept = async () => {
        setAccepting(true);
        try {
            // What the reviewer did last is part of what they accept.
            await Promise.all(pending.current.values());
            const shown = dataRef.current;
            const result = await acceptTaskReview(recordingId, {
                proposals: shown?.proposals.map((row) => row.id) ?? [],
                updates: shown?.updates.map((row) => row.id) ?? [],
            });
            toast.success(
                i18n(
                    "{count, plural, one {# task accepted} other {# tasks accepted}}",
                    { count: result.accepted },
                ),
            );
            if (result.updatesSkipped > 0) {
                toast.info(
                    i18n(
                        "{count, plural, one {# earlier task was} other {# earlier tasks were}} left as they were: closed meanwhile, or not yours to change.",
                        { count: result.updatesSkipped },
                    ),
                );
            }
            announceTasksChanged();
            announceLearnReviewsChanged();
            await reload();
        } catch (error) {
            if (error instanceof TaskRequestError && error.conflict) {
                toast.error(
                    i18n(
                        "The proposals changed meanwhile. Look them over again.",
                    ),
                );
                await reload();
            } else {
                await failure(error);
            }
        } finally {
            setAccepting(false);
        }
    };

    if (failed) return <>{fallback}</>;
    if (!data) {
        return (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {i18n("Loading tasks…")}
            </p>
        );
    }

    const reviewing =
        data.canEdit && (data.proposals.length > 0 || data.updates.length > 0);
    const dropped = data.tasks.filter((task) => task.status === "dropped");
    const shown = data.tasks.filter(
        (task) => showDropped || task.status !== "dropped",
    );
    const canAdd = data.canEdit && allowAdd;
    // No tasks: the summary's own list, as before tasks, unless a review
    // already said what its items were.
    if (!reviewing && data.tasks.length === 0) {
        return (
            <div className="space-y-2">
                {data.reviewed ? null : fallback}
                {canAdd && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void add("open")}
                    >
                        <Plus className="mr-1 size-3.5" />
                        {i18n("Add task")}
                    </Button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {reviewing && (
                <section
                    aria-label={i18n("Proposed tasks")}
                    className="space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-3"
                >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="flex items-center gap-2 text-sm font-medium">
                            <ListChecks className="size-4 text-primary" />
                            {i18n("Proposed tasks")}
                        </h4>
                        <div className="flex items-center gap-2">
                            {merging ? (
                                <>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={merging.length < 2}
                                        onClick={() => void merge()}
                                    >
                                        <Combine className="mr-1 size-3.5" />
                                        {i18n(
                                            "Merge {count, plural, one {# task} other {# tasks}}",
                                            { count: merging.length },
                                        )}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setMerging(null)}
                                    >
                                        <X className="size-3.5" />
                                        <span className="sr-only">
                                            {i18n("Cancel merging")}
                                        </span>
                                    </Button>
                                </>
                            ) : (
                                data.proposals.length > 1 && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setMerging([])}
                                    >
                                        <Combine className="mr-1 size-3.5" />
                                        {i18n("Merge…")}
                                    </Button>
                                )
                            )}
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {merging
                            ? i18n(
                                  "Select the tasks that are one. They become the first one selected.",
                              )
                            : i18n(
                                  "Untick what is not a task, correct who and when, then accept. Accepted tasks appear in the Tasks list.",
                              )}
                    </p>
                    <ul className="space-y-2">
                        {data.proposals.map((task) => (
                            <TaskRow
                                key={task.id}
                                task={task}
                                proposal
                                speakers={speakers}
                                organizationOnly={organizationOnly}
                                onPlay={onPlay}
                                selection={
                                    merging
                                        ? {
                                              selected: merging.includes(
                                                  task.id,
                                              ),
                                              onToggle: () =>
                                                  toggleMerging(task.id),
                                          }
                                        : null
                                }
                                onChange={(change, optimistic) =>
                                    update(task, change, optimistic)
                                }
                                onReject={() => reject(task)}
                            />
                        ))}
                    </ul>
                    {data.updates.length > 0 && (
                        <div className="space-y-2">
                            <h5 className="text-xs font-medium text-muted-foreground">
                                {i18n("Heard about earlier tasks")}
                            </h5>
                            <ul className="space-y-1.5">
                                {data.updates.map((update) => (
                                    <UpdateRow
                                        key={update.id}
                                        update={update}
                                        onPlay={onPlay}
                                        onToggle={(ticked) =>
                                            tickUpdate(update, ticked)
                                        }
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        {canAdd ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void add("proposed")}
                            >
                                <Plus className="mr-1 size-3.5" />
                                {i18n("Add task")}
                            </Button>
                        ) : (
                            <span />
                        )}
                        <Button
                            size="sm"
                            disabled={accepting || merging !== null}
                            onClick={() => void accept()}
                        >
                            {accepting && (
                                <Loader2 className="mr-2 size-3.5 animate-spin" />
                            )}
                            {i18n("Accept tasks")}
                        </Button>
                    </div>
                </section>
            )}

            {(shown.length > 0 || (canAdd && !reviewing)) && (
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
                        <ul className="space-y-1.5">
                            {shown.map((task) => (
                                <TaskRow
                                    key={task.id}
                                    task={task}
                                    proposal={false}
                                    speakers={speakers}
                                    organizationOnly={organizationOnly}
                                    onPlay={onPlay}
                                    selection={null}
                                    onChange={(change, optimistic) =>
                                        update(task, change, optimistic)
                                    }
                                />
                            ))}
                        </ul>
                    )}
                    {canAdd && !reviewing && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void add("open")}
                        >
                            <Plus className="mr-1 size-3.5" />
                            {i18n("Add task")}
                        </Button>
                    )}
                </section>
            )}
        </div>
    );
}

function TaskRow({
    task,
    proposal,
    speakers,
    organizationOnly,
    onPlay,
    selection,
    onChange,
    onReject,
}: {
    task: TaskView;
    proposal: boolean;
    speakers: readonly SpeakerChoice[];
    organizationOnly: boolean;
    onPlay?: (startMs: number) => void;
    selection: { selected: boolean; onToggle: () => void } | null;
    onChange: (
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => void;
    onReject?: () => void;
}) {
    const i18n = useExtracted();
    const [draft, setDraft] = useState(task.text);
    useEffect(() => setDraft(task.text), [task.text]);
    const done = task.status === "done";
    const droppedTask = task.status === "dropped";

    const saveText = () => {
        const text = draft.trim();
        if (!text || text === task.text) {
            setDraft(task.text);
            return;
        }
        onChange({ text }, { text });
    };

    return (
        <li
            className={cn(
                "flex items-start gap-2 rounded-md text-sm",
                proposal && "bg-background p-2 shadow-xs",
                proposal && !task.ticked && "opacity-60",
                selection?.selected && "ring-2 ring-primary",
            )}
        >
            {selection ? (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0 accent-primary"
                    checked={selection.selected}
                    onChange={selection.onToggle}
                    aria-label={i18n("Select to merge")}
                />
            ) : proposal ? (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0"
                    checked={task.ticked}
                    onChange={(event) =>
                        onChange(
                            { ticked: event.target.checked },
                            { ticked: event.target.checked },
                        )
                    }
                    aria-label={i18n("Keep this task")}
                />
            ) : (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0 accent-primary"
                    checked={done}
                    disabled={!task.canClose || droppedTask}
                    onChange={(event) => {
                        const status = event.target.checked ? "done" : "open";
                        onChange({ status }, { status });
                    }}
                    aria-label={i18n("Done")}
                />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
                {task.canEdit && !droppedTask ? (
                    <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={saveText}
                        onKeyDown={(event) => {
                            if (event.key === "Enter")
                                event.currentTarget.blur();
                            if (event.key === "Escape") {
                                setDraft(task.text);
                                event.currentTarget.blur();
                            }
                        }}
                        aria-label={i18n("Task")}
                        className={cn(
                            "w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-ring focus:outline-none",
                            done && "text-muted-foreground line-through",
                        )}
                    />
                ) : (
                    <p
                        className={cn(
                            "px-1 py-0.5",
                            (done || droppedTask) &&
                                "text-muted-foreground line-through",
                        )}
                    >
                        {task.text}
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-2 px-1">
                    <AssigneePicker
                        value={task.assignee}
                        hint={task.assigneeHint}
                        check={proposal && task.assigneeCheck}
                        speakers={speakers}
                        organizationOnly={organizationOnly}
                        disabled={!task.canEdit || droppedTask}
                        onChange={(person) =>
                            onChange(
                                { assigneePersonId: person?.personId ?? null },
                                {
                                    assignee: person,
                                    assigneeHint: null,
                                    assigneeCheck: false,
                                },
                            )
                        }
                    />
                    <DueDateField
                        value={task.dueDate}
                        phrase={proposal ? task.duePhrase : null}
                        overdue={!proposal && task.status === "open"}
                        disabled={!task.canEdit || droppedTask}
                        onChange={(dueDate) =>
                            onChange({ dueDate }, { dueDate })
                        }
                    />
                    {task.evidenceStartMs !== null && onPlay && (
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                            title={task.quote ?? undefined}
                            onClick={() =>
                                onPlay(task.evidenceStartMs as number)
                            }
                        >
                            <Play className="size-3" />
                            {i18n("Where it was said")}
                        </button>
                    )}
                    {!proposal && task.canEdit && (
                        <button
                            type="button"
                            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => {
                                const status = droppedTask ? "open" : "dropped";
                                onChange({ status }, { status });
                            }}
                        >
                            {droppedTask ? (
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
            {proposal && onReject && !selection && (
                <button
                    type="button"
                    className="mt-1 text-muted-foreground hover:text-destructive"
                    onClick={onReject}
                    aria-label={i18n("Reject this task")}
                    title={i18n("Reject this task")}
                >
                    <Trash2 className="size-4" />
                </button>
            )}
        </li>
    );
}

function UpdateRow({
    update,
    onPlay,
    onToggle,
}: {
    update: TaskUpdateView;
    onPlay?: (startMs: number) => void;
    onToggle: (ticked: boolean) => void;
}) {
    const i18n = useExtracted();
    return (
        <li className="flex items-start gap-2 rounded-md bg-background p-2 text-sm shadow-xs">
            <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={update.ticked}
                onChange={(event) => onToggle(event.target.checked)}
                aria-label={i18n("Apply this")}
            />
            <div className="min-w-0 flex-1">
                <p>
                    <span className="font-medium">
                        {update.kind === "done"
                            ? i18n("Mark done:")
                            : i18n("Move due date to {date}:", {
                                  date: update.dueDate ?? "",
                              })}
                    </span>{" "}
                    {update.task.text}
                </p>
                <p className="text-xs text-muted-foreground">
                    {update.task.assigneeName
                        ? i18n("{name}, from {recording}", {
                              name: update.task.assigneeName,
                              recording: update.task.recordingTitle,
                          })
                        : i18n("From {recording}", {
                              recording: update.task.recordingTitle,
                          })}
                    {update.quote && <> · “{update.quote}”</>}
                </p>
            </div>
            {update.evidenceStartMs !== null && onPlay && (
                <button
                    type="button"
                    className="mt-1 text-muted-foreground hover:text-primary"
                    onClick={() => onPlay(update.evidenceStartMs as number)}
                    aria-label={i18n("Where it was said")}
                >
                    <Play className="size-3.5" />
                </button>
            )}
        </li>
    );
}
