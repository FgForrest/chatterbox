"use client";

import {
    Ban,
    Combine,
    ListChecks,
    Loader2,
    UserRoundPen,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { HelpLink } from "@/components/help/help-button";
import {
    WorkflowWidget,
    WorkflowWidgetLine,
} from "@/components/pipeline/workflow-widget";
import { usePlayback } from "@/components/playback/playback-context";
import { AddTaskButton } from "@/components/tasks/add-task-button";
import {
    AssigneePicker,
    type SpeakerChoice,
} from "@/components/tasks/assignee-picker";
import { MergeTaskPicker } from "@/components/tasks/merge-task-picker";
import { TaskEvidenceLink } from "@/components/tasks/task-evidence-link";
import { DueDateField, TaskTextInput } from "@/components/tasks/task-fields";
import type {
    RecordingTasksState,
    TaskRowChange,
} from "@/components/tasks/use-recording-tasks";
import { Button } from "@/components/ui/button";
import type { WorkflowWidgetFrame } from "@/lib/pipeline/workflow-widgets";
import type {
    TaskMatchView,
    TaskUpdateView,
    TaskView,
} from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";

function evidenceKey(value: {
    quote: string | null;
    evidenceStartMs: number | null;
    evidenceText: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    } | null;
}) {
    return JSON.stringify([
        value.quote,
        value.evidenceStartMs,
        value.evidenceText?.segmentIndex ?? null,
        value.evidenceText?.charStart ?? null,
        value.evidenceText?.charEnd ?? null,
    ]);
}

/**
 * The proposed tasks of a recording, the way Learn's findings are: a link
 * with how many wait, opening a review to tick, correct or merge them and
 * the follow-ups heard about earlier tasks, then apply the selected changes.
 * Unticking is the one way to say no: it stays undoable until the review is applied.
 */
export function TaskReviewLink({
    state,
    speakers,
    organizationOnly,
    allowAdd = true,
    frame = "dialog",
    widgetId,
    showTrigger = true,
}: {
    state: RecordingTasksState;
    /** People attributed to the recording's speakers, offered first. */
    speakers: readonly SpeakerChoice[];
    /** The Organization view: assignees come from the Organization only. */
    organizationOnly: boolean;
    /** Offer adding tasks by hand; not without a summary they would die with. */
    allowAdd?: boolean;
    frame?: WorkflowWidgetFrame;
    widgetId?: string;
    showTrigger?: boolean;
}) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [merging, setMerging] = useState<string[] | null>(null);
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
    const { data, reviewing, waiting } = state;
    const resolvedWidgetId = widgetId ?? `task-review-${state.itemId}`;

    // Nothing left to review: the dialog has done its job.
    useEffect(() => {
        if (!reviewing) {
            setOpen(false);
            setMerging(null);
        }
    }, [reviewing]);

    useEffect(() => {
        if (!focusTaskId) return;
        const card = [
            ...document.querySelectorAll<HTMLElement>(
                "[data-task-review-card]",
            ),
        ].find((element) => element.dataset.taskReviewCard === focusTaskId);
        const input = card?.querySelector<
            HTMLInputElement | HTMLTextAreaElement
        >('textarea, input:not([type]), input[type="text"]');
        if (!card || !input) return;
        card.scrollIntoView?.({ block: "nearest" });
        input.focus({ preventScroll: true });
        setFocusTaskId(null);
    }, [focusTaskId]);

    if (!data || !reviewing) return null;

    /** Select or unselect a proposal to merge, keeping the selection order. */
    const toggleMerging = (id: string) =>
        setMerging((current) => {
            const selected = current ?? [];
            return selected.includes(id)
                ? selected.filter((other) => other !== id)
                : [...selected, id];
        });

    const merge = async () => {
        if (merging && (await state.merge(merging))) setMerging(null);
    };

    const addTask = async () => {
        const added = await state.add("proposed");
        if (added) setFocusTaskId(added.id);
    };

    const actionableUpdateTaskIds = new Set(
        data.updates
            .filter((update) => !update.earlierMention)
            .map((update) => update.task.id),
    );
    const earlierMentionTaskIds = new Set(
        data.updates
            .filter((update) => update.earlierMention)
            .map((update) => update.task.id),
    );
    const matchOnlyTaskIds = new Set(
        data.matches
            .filter(
                (match) =>
                    !actionableUpdateTaskIds.has(match.candidate.id) &&
                    !earlierMentionTaskIds.has(match.candidate.id),
            )
            .map((match) => match.candidate.id),
    );
    const tickedFollowUps = [...actionableUpdateTaskIds].filter(
        (taskId) =>
            data.updates.some(
                (update) => update.task.id === taskId && update.ticked,
            ) ||
            data.matches.some(
                (match) => match.candidate.id === taskId && match.ticked,
            ),
    ).length;
    const ticked =
        new Set(
            data.proposals.filter((task) => task.ticked).map((task) => task.id),
        ).size +
        [...matchOnlyTaskIds].filter((taskId) =>
            data.matches.some(
                (match) => match.candidate.id === taskId && match.ticked,
            ),
        ).length +
        tickedFollowUps;
    const updatesByTaskId = new Map<string, TaskUpdateView[]>();
    for (const update of data.updates) {
        const updates = updatesByTaskId.get(update.task.id) ?? [];
        updates.push(update);
        updatesByTaskId.set(update.task.id, updates);
    }
    const ambiguous = new Map<
        string,
        { matches: TaskMatchView[]; proposal: TaskView | null }
    >();
    for (const match of data.matches.filter((row) => row.ambiguous)) {
        const key = evidenceKey(match);
        const group = ambiguous.get(key) ?? {
            matches: [],
            proposal:
                data.proposals.find(
                    (proposal) => evidenceKey(proposal) === key,
                ) ?? null,
        };
        group.matches.push(match);
        ambiguous.set(key, group);
    }
    const ambiguousMatchIds = new Set(
        [...ambiguous.values()].flatMap((group) =>
            group.matches.map((match) => match.id),
        ),
    );
    const pairedProposalIds = new Set(
        [...ambiguous.values()].flatMap((group) =>
            group.proposal ? [group.proposal.id] : [],
        ),
    );
    const visibleProposals = data.proposals.filter(
        (proposal) => !pairedProposalIds.has(proposal.id),
    );
    const matchedTaskIds = new Set(
        data.matches.map((match) => match.candidate.id),
    );
    const standaloneUpdates = [...updatesByTaskId.entries()].filter(
        ([taskId]) => !matchedTaskIds.has(taskId),
    );

    return (
        <>
            {showTrigger && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto gap-1 px-0 text-sm font-medium hover:bg-transparent hover:text-primary"
                    onClick={() => setOpen(true)}
                >
                    <ListChecks className="size-4" />
                    {i18n("Review tasks ({count})", {
                        count: String(waiting),
                    })}
                </Button>
            )}
            <WorkflowWidget
                id={resolvedWidgetId}
                frame={frame}
                tone="review"
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) setMerging(null);
                }}
                title={
                    <>
                        <ListChecks className="size-4" />
                        {i18n("Task review")}
                    </>
                }
                helpLink={
                    <HelpLink
                        topic="tasks.review"
                        label={i18n("reviewing proposed tasks")}
                    />
                }
                description={
                    merging
                        ? i18n(
                              "Select the tasks that are one. They become the first one selected.",
                          )
                        : i18n(
                              "What the summary found to do. Untick what is not a task, correct who and when, then apply the selected changes. Unticked ones are not proposed again.",
                          )
                }
                footer={{
                    status: i18n("{ticked} of {count} will be applied", {
                        ticked: String(ticked),
                        count: String(waiting),
                    }),
                    actions: (
                        <Button
                            disabled={state.accepting || merging !== null}
                            onClick={() => void state.accept()}
                        >
                            {state.accepting && (
                                <Loader2 className="size-4 animate-spin" />
                            )}
                            {i18n("Apply selected changes")}
                        </Button>
                    ),
                }}
                closeLabel={i18n("Save and continue later")}
                dialogWidth="xl"
                dialogLine={
                    showTrigger ? undefined : (
                        <WorkflowWidgetLine
                            title={i18n("Task review")}
                            facts={i18n(
                                "{count, plural, one {# change waits for your review} other {# changes wait for your review}}",
                                { count: waiting },
                            )}
                            tone="review"
                            action={
                                <Button size="sm" onClick={() => setOpen(true)}>
                                    {i18n("Review")}
                                </Button>
                            }
                        />
                    )
                }
            >
                <div className="space-y-8">
                    {data.matches.length > 0 && (
                        <section className="space-y-2">
                            <SectionTitle
                                title={i18n("Suggested matches")}
                                count={data.matches.length}
                            />
                            <ul className="space-y-2">
                                {data.matches
                                    .filter(
                                        (match) =>
                                            !ambiguousMatchIds.has(match.id),
                                    )
                                    .map((match) => (
                                        <SuggestedMatchRow
                                            key={match.id}
                                            match={match}
                                            updates={
                                                updatesByTaskId.get(
                                                    match.candidate.id,
                                                ) ?? []
                                            }
                                            itemId={state.itemId}
                                            onNavigate={() => setOpen(false)}
                                            onToggle={(ticked) => {
                                                state.tickMatch(match, ticked);
                                                if (!ticked) {
                                                    for (const update of updatesByTaskId.get(
                                                        match.candidate.id,
                                                    ) ?? []) {
                                                        if (
                                                            !update.earlierMention
                                                        ) {
                                                            state.tickUpdate(
                                                                update,
                                                                false,
                                                            );
                                                        }
                                                    }
                                                }
                                            }}
                                            onToggleUpdate={(
                                                update,
                                                ticked,
                                            ) => {
                                                if (ticked) {
                                                    state.tickMatch(
                                                        match,
                                                        true,
                                                    );
                                                }
                                                state.tickUpdate(
                                                    update,
                                                    ticked,
                                                );
                                            }}
                                        />
                                    ))}
                                {[...ambiguous.entries()].map(
                                    ([key, group]) => (
                                        <AmbiguousMatchRow
                                            key={key}
                                            matches={group.matches}
                                            proposal={group.proposal}
                                            itemId={state.itemId}
                                            onNavigate={() => setOpen(false)}
                                            updatesByTaskId={updatesByTaskId}
                                            onChoose={(selected) => {
                                                for (const match of group.matches) {
                                                    state.tickMatch(
                                                        match,
                                                        selected === match.id,
                                                    );
                                                }
                                                if (group.proposal) {
                                                    const keep =
                                                        selected === "new";
                                                    state.update(
                                                        group.proposal,
                                                        { ticked: keep },
                                                        { ticked: keep },
                                                    );
                                                }
                                            }}
                                            onMerge={state.mergeInto}
                                            onToggleUpdate={(
                                                match,
                                                update,
                                                ticked,
                                            ) => {
                                                if (ticked) {
                                                    for (const candidate of group.matches) {
                                                        state.tickMatch(
                                                            candidate,
                                                            candidate.id ===
                                                                match.id,
                                                        );
                                                    }
                                                    if (group.proposal) {
                                                        state.update(
                                                            group.proposal,
                                                            {
                                                                ticked: false,
                                                            },
                                                            {
                                                                ticked: false,
                                                            },
                                                        );
                                                    }
                                                }
                                                state.tickUpdate(
                                                    update,
                                                    ticked,
                                                );
                                            }}
                                        />
                                    ),
                                )}
                            </ul>
                        </section>
                    )}
                    {(visibleProposals.length > 0 || allowAdd) && (
                        <section className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <SectionTitle
                                    title={i18n("Tasks")}
                                    count={visibleProposals.length}
                                />
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
                                                    {
                                                        count: merging.length,
                                                    },
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
                                        visibleProposals.length > 1 && (
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
                            {visibleProposals.length > 0 && (
                                <ul className="space-y-2">
                                    {visibleProposals.map((task) => (
                                        <ProposalRow
                                            key={task.id}
                                            task={task}
                                            speakers={speakers}
                                            organizationOnly={organizationOnly}
                                            onNavigate={() => setOpen(false)}
                                            onMerge={(targetTaskId) =>
                                                state.mergeInto(
                                                    task.id,
                                                    targetTaskId,
                                                )
                                            }
                                            selection={
                                                merging
                                                    ? {
                                                          selected:
                                                              merging.includes(
                                                                  task.id,
                                                              ),
                                                          onToggle: () =>
                                                              toggleMerging(
                                                                  task.id,
                                                              ),
                                                      }
                                                    : null
                                            }
                                            onChange={(change, optimistic) =>
                                                state.update(
                                                    task,
                                                    change,
                                                    optimistic,
                                                )
                                            }
                                        />
                                    ))}
                                </ul>
                            )}
                            {allowAdd && !merging && (
                                <AddTaskButton onClick={() => void addTask()} />
                            )}
                        </section>
                    )}
                    {standaloneUpdates.length > 0 && (
                        <section className="space-y-2">
                            <SectionTitle
                                title={i18n("Heard about earlier tasks")}
                                count={standaloneUpdates.length}
                            />
                            <ul className="space-y-2">
                                {standaloneUpdates.map(([taskId, updates]) => (
                                    <li
                                        key={taskId}
                                        data-task-review-card={taskId}
                                        className="-mx-2 space-y-2 rounded-md border px-3 py-2 text-sm"
                                    >
                                        {updates.map((update) => (
                                            <UpdateRow
                                                key={update.id}
                                                update={update}
                                                itemId={state.itemId}
                                                onNavigate={() =>
                                                    setOpen(false)
                                                }
                                                onToggle={(next) =>
                                                    state.tickUpdate(
                                                        update,
                                                        next,
                                                    )
                                                }
                                            />
                                        ))}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            </WorkflowWidget>
        </>
    );
}

/** A section of the review: what it holds, and how many. */
function SectionTitle({ title, count }: { title: string; count: number }) {
    return (
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
            {title}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {count}
            </span>
        </h3>
    );
}

function ProposalRow({
    task,
    speakers,
    organizationOnly,
    onNavigate,
    selection,
    onChange,
    onMerge,
}: {
    task: TaskView;
    speakers: readonly SpeakerChoice[];
    organizationOnly: boolean;
    onNavigate: () => void;
    selection: { selected: boolean; onToggle: () => void } | null;
    onChange: TaskRowChange;
    onMerge: (targetTaskId: string) => Promise<boolean>;
}) {
    const i18n = useExtracted();

    return (
        <li
            data-task-review-card={task.id}
            className={cn(
                "-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50",
                !task.ticked && !selection && "opacity-60",
                selection?.selected && "bg-primary/5 ring-2 ring-primary",
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
            ) : (
                <input
                    type="checkbox"
                    className="mt-1.5 size-4 shrink-0"
                    checked={task.ticked}
                    disabled={!task.canEdit}
                    onChange={(event) =>
                        onChange(
                            { ticked: event.target.checked },
                            { ticked: event.target.checked },
                        )
                    }
                    aria-label={i18n("Keep this task")}
                />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
                {task.canEdit ? (
                    <TaskTextInput
                        text={task.text}
                        onSave={(text) => onChange({ text }, { text })}
                        className="w-full py-0.5"
                    />
                ) : (
                    <p className="px-1 py-0.5">{task.text}</p>
                )}
                {task.source === "plaud" && (
                    <p className="px-1 text-xs font-medium text-muted-foreground">
                        {i18n("Not matched against earlier tasks")}
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-2 px-1">
                    <AssigneePicker
                        value={task.assignee}
                        hint={task.assigneeHint}
                        check={task.assigneeCheck}
                        speakers={speakers}
                        organizationOnly={organizationOnly}
                        disabled={!task.canEdit}
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
                        phrase={task.duePhrase}
                        overdue={false}
                        disabled={!task.canEdit}
                        onChange={(dueDate) =>
                            onChange({ dueDate }, { dueDate })
                        }
                    />
                    <TaskEvidenceLink
                        evidence={{
                            itemId: task.evidenceItemId ?? "",
                            itemKind: task.evidenceItemKind,
                            audioAvailable: task.evidenceAudioAvailable,
                            startMs: task.evidenceStartMs,
                            text: task.evidenceText,
                        }}
                        quote={task.quote}
                        currentItemId={task.recordingId ?? undefined}
                        onNavigate={onNavigate}
                    />
                    {task.quote &&
                        (task.evidenceStartMs !== null ||
                            task.evidenceText !== null) && (
                            <span className="min-w-0 truncate text-xs italic text-muted-foreground">
                                “{task.quote}”
                            </span>
                        )}
                    <ProvenanceNote provenance={task.evidenceProvenance} />
                    {!selection && task.canEdit && (
                        <MergeTaskPicker
                            itemId={task.recordingId}
                            sourceTaskId={task.id}
                            label={i18n("Merge into an earlier task")}
                            searchLabel={i18n("Search earlier tasks")}
                            onMerge={onMerge}
                        />
                    )}
                </div>
            </div>
        </li>
    );
}

/** Why a proposal read in a mail is worth a second look. */
function ProvenanceNote({
    provenance,
}: {
    provenance: TaskView["evidenceProvenance"];
}) {
    const i18n = useExtracted();
    if (!provenance) return null;
    return (
        <span className="text-xs text-amber-700 dark:text-amber-400">
            {provenance === "quoted"
                ? i18n("From an earlier message quoted in the mail")
                : provenance === "unverified"
                  ? i18n("From a sender nothing verified")
                  : i18n("Its words were not found in the mail")}
        </span>
    );
}

function CandidateDetails({ match }: { match: TaskMatchView }) {
    const i18n = useExtracted();
    const status =
        match.candidate.status === "open"
            ? i18n("Open")
            : match.candidate.status === "done"
              ? i18n("Done")
              : match.candidate.status === "dropped"
                ? i18n("No longer needed")
                : i18n("Proposed");
    return (
        <div className="space-y-1">
            <p className="font-medium">{match.candidate.text}</p>
            <p className="text-xs text-muted-foreground">
                {match.candidate.assignee?.name ?? i18n("Unassigned")} ·{" "}
                {match.candidate.dueDate ??
                    match.candidate.duePhrase ??
                    i18n("No due date")}{" "}
                · {status}
            </p>
            <p className="text-xs text-muted-foreground">
                {i18n("From {recording}", {
                    recording: match.candidate.homeItem.title,
                })}
            </p>
        </div>
    );
}

function MatchEvidence({
    match,
    itemId,
    onNavigate,
    showQuote = false,
}: {
    match: TaskMatchView;
    itemId: string;
    onNavigate?: () => void;
    showQuote?: boolean;
}) {
    const playback = usePlayback();
    return (
        <TaskEvidenceLink
            evidence={{
                itemId,
                itemKind: match.evidenceText ? "mail" : "audio",
                audioAvailable: playback !== null,
                startMs: match.evidenceStartMs,
                text: match.evidenceText,
            }}
            quote={match.quote}
            currentItemId={itemId}
            onNavigate={onNavigate}
            showQuote={showQuote}
        />
    );
}

function SuggestedMatchRow({
    match,
    updates,
    itemId,
    onNavigate,
    onToggle,
    onToggleUpdate,
}: {
    match: TaskMatchView;
    updates: readonly TaskUpdateView[];
    itemId: string;
    onNavigate: () => void;
    onToggle: (ticked: boolean) => void;
    onToggleUpdate: (update: TaskUpdateView, ticked: boolean) => void;
}) {
    const i18n = useExtracted();
    const actionable =
        updates.length === 0 ||
        updates.some((update) => !update.earlierMention);
    return (
        <li
            data-task-review-card={match.candidate.id}
            className="-mx-2 space-y-3 rounded-md border px-3 py-3 text-sm"
        >
            {actionable && (
                <label className="flex items-start gap-2">
                    <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={match.ticked}
                        onChange={(event) => onToggle(event.target.checked)}
                        aria-label={i18n("Apply suggested match to {task}", {
                            task: match.candidate.text,
                        })}
                    />
                    <span>
                        <span className="block font-medium">
                            {i18n("Same task: attach this mention")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                            {i18n(
                                "Accepting this match changes nothing else on the task.",
                            )}
                        </span>
                    </span>
                </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
                <section className="min-w-0 space-y-2 rounded-md bg-muted/40 p-3">
                    <h4 className="text-xs font-semibold text-primary">
                        {i18n("Earlier task")}
                    </h4>
                    <CandidateDetails match={match} />
                    <TaskEvidenceLink
                        evidence={{
                            itemId: match.candidate.homeItem.id,
                            itemKind: match.candidate.homeItem.kind,
                            audioAvailable:
                                match.candidate.homeItem.audioAvailable,
                            startMs: match.candidate.evidenceStartMs,
                            text: match.candidate.evidenceText,
                        }}
                        quote={match.candidate.quote}
                        onNavigate={onNavigate}
                        showQuote
                    />
                </section>
                <section className="min-w-0 space-y-2 rounded-md bg-muted/40 p-3">
                    <h4 className="text-xs font-semibold text-primary">
                        {i18n("Said now")}
                    </h4>
                    <MatchEvidence
                        match={match}
                        itemId={itemId}
                        onNavigate={onNavigate}
                        showQuote
                    />
                </section>
            </div>
            {updates.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                    {updates.map((update) => (
                        <UpdateRow
                            key={update.id}
                            update={update}
                            itemId={itemId}
                            onNavigate={onNavigate}
                            onToggle={(ticked) =>
                                onToggleUpdate(update, ticked)
                            }
                        />
                    ))}
                </div>
            )}
        </li>
    );
}

function AmbiguousMatchRow({
    matches,
    proposal,
    itemId,
    onNavigate,
    updatesByTaskId,
    onChoose,
    onMerge,
    onToggleUpdate,
}: {
    matches: readonly TaskMatchView[];
    proposal: TaskView | null;
    itemId: string;
    onNavigate: () => void;
    updatesByTaskId: ReadonlyMap<string, readonly TaskUpdateView[]>;
    onChoose: (selected: string | "new") => void;
    onMerge: (sourceTaskId: string, targetTaskId: string) => Promise<boolean>;
    onToggleUpdate: (
        match: TaskMatchView,
        update: TaskUpdateView,
        ticked: boolean,
    ) => void;
}) {
    const i18n = useExtracted();
    const selected =
        matches.find((match) => match.ticked)?.id ??
        (proposal?.ticked ? "new" : "");
    return (
        <li className="-mx-2 rounded-md border px-3 py-2 text-sm">
            <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-primary">
                    {i18n("Choose a task match")}
                </legend>
                <div role="radiogroup" aria-label={i18n("Choose a task match")}>
                    {matches.map((match) => (
                        <div
                            key={match.id}
                            data-task-review-card={match.candidate.id}
                            className="space-y-2 py-1"
                        >
                            <label className="flex items-start gap-2">
                                <input
                                    type="radio"
                                    name={`match-${matches[0]?.id}`}
                                    checked={selected === match.id}
                                    onChange={() => onChoose(match.id)}
                                    aria-label={match.candidate.text}
                                />
                                <CandidateDetails match={match} />
                            </label>
                            {(updatesByTaskId.get(match.candidate.id) ?? [])
                                .length > 0 && (
                                <div className="ml-5 space-y-2 border-l pl-3">
                                    {(
                                        updatesByTaskId.get(
                                            match.candidate.id,
                                        ) ?? []
                                    ).map((update) => (
                                        <UpdateRow
                                            key={update.id}
                                            update={update}
                                            itemId={itemId}
                                            onNavigate={onNavigate}
                                            onToggle={(ticked) =>
                                                onToggleUpdate(
                                                    match,
                                                    update,
                                                    ticked,
                                                )
                                            }
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                    {proposal && (
                        <label className="flex items-center gap-2 py-1">
                            <input
                                type="radio"
                                name={`match-${matches[0]?.id}`}
                                checked={selected === "new"}
                                readOnly
                                onClick={() => onChoose("new")}
                                aria-label={i18n("Keep as new")}
                            />
                            {i18n("Keep as new")}
                        </label>
                    )}
                </div>
                {matches[0] && (
                    <MatchEvidence
                        match={matches[0]}
                        itemId={itemId}
                        onNavigate={onNavigate}
                        showQuote
                    />
                )}
                {proposal?.canEdit && (
                    <MergeTaskPicker
                        itemId={proposal.recordingId}
                        sourceTaskId={proposal.id}
                        label={i18n("Merge into an earlier task")}
                        searchLabel={i18n("Search earlier tasks")}
                        onMerge={(targetTaskId) =>
                            onMerge(proposal.id, targetTaskId)
                        }
                    />
                )}
            </fieldset>
        </li>
    );
}

function UpdateRow({
    update,
    itemId,
    onNavigate,
    onToggle,
}: {
    update: TaskUpdateView;
    itemId: string;
    onNavigate: () => void;
    onToggle: (ticked: boolean) => void;
}) {
    const i18n = useExtracted();
    const playback = usePlayback();
    const evidence = (
        <TaskEvidenceLink
            evidence={{
                itemId,
                itemKind: update.evidenceText ? "mail" : "audio",
                audioAvailable: playback !== null,
                startMs: update.evidenceStartMs,
                text: update.evidenceText,
            }}
            quote={update.quote}
            currentItemId={itemId}
            onNavigate={onNavigate}
        />
    );
    if (update.earlierMention) {
        return (
            <div className="space-y-1 text-sm">
                <p className="font-medium">{i18n("Earlier mention")}</p>
                <p>{update.task.text}</p>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "No action is offered because newer information already set this field.",
                    )}
                </p>
                {evidence}
            </div>
        );
    }
    return (
        <div className="text-sm">
            {update.kind === "done" ? (
                <label className="flex items-start gap-2">
                    <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={update.ticked}
                        onChange={(event) => onToggle(event.target.checked)}
                        aria-label={i18n("Confirm task completion")}
                    />
                    <span>
                        <span className="block font-medium">
                            {i18n("Needs confirmation")}
                        </span>
                        {update.task.text}
                    </span>
                </label>
            ) : update.kind === "drop" ? (
                <label className="flex items-start gap-2">
                    <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={update.ticked}
                        onChange={(event) => onToggle(event.target.checked)}
                        aria-label={i18n("Confirm task is no longer needed")}
                    />
                    <span>
                        <span className="flex items-center gap-1 font-medium">
                            <Ban className="size-3.5" />
                            {i18n("No longer needed")}
                        </span>
                        {update.task.text}
                    </span>
                </label>
            ) : update.kind === "assignee" ? (
                <label className="flex items-start gap-2">
                    <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0"
                        checked={update.ticked}
                        onChange={(event) => onToggle(event.target.checked)}
                        aria-label={i18n("Confirm new assignee")}
                    />
                    <span>
                        <span className="flex items-center gap-1 font-medium">
                            <UserRoundPen className="size-3.5" />
                            {i18n("Handed to someone else")}
                        </span>
                        <span>{update.task.text}</span>
                        <span
                            className={cn(
                                "block text-xs text-muted-foreground",
                                (update.proposedAssigneeCheck ||
                                    update.proposedAssigneeHint) &&
                                    "text-amber-700 dark:text-amber-400",
                            )}
                            title={
                                update.proposedAssigneeHint
                                    ? i18n(
                                          "Heard {name}, who is not in Almanac.",
                                          {
                                              name: update.proposedAssigneeHint,
                                          },
                                      )
                                    : update.proposedAssigneeCheck
                                      ? i18n("Check this assignment")
                                      : undefined
                            }
                        >
                            {update.task.assigneeName ?? i18n("Unassigned")} →{" "}
                            {update.proposedAssignee?.name ??
                                (update.proposedAssigneeHint
                                    ? `${update.proposedAssigneeHint}?`
                                    : i18n("Unassigned"))}
                        </span>
                    </span>
                </label>
            ) : (
                <fieldset className="space-y-1">
                    <legend className="font-medium">{update.task.text}</legend>
                    <label className="flex items-center gap-2">
                        <input
                            type="radio"
                            name={`deadline-${update.id}`}
                            checked={!update.ticked}
                            onChange={() => onToggle(false)}
                            aria-label={i18n("Keep the current deadline")}
                        />
                        <span>
                            <span className="block text-xs text-muted-foreground">
                                {i18n("Current deadline")}
                            </span>
                            {update.task.dueDate ??
                                update.task.duePhrase ??
                                i18n("No due date")}
                        </span>
                    </label>
                    <label className="flex items-center gap-2">
                        <input
                            type="radio"
                            name={`deadline-${update.id}`}
                            checked={update.ticked}
                            onChange={() => onToggle(true)}
                            aria-label={i18n("Use the proposed deadline")}
                        />
                        <span>
                            <span className="block text-xs text-muted-foreground">
                                {i18n("Proposed deadline")}
                            </span>
                            {update.dueDate ??
                                update.duePhrase ??
                                i18n("No due date")}
                        </span>
                    </label>
                </fieldset>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                    {update.task.assigneeName
                        ? i18n("{name}, from {recording}", {
                              name: update.task.assigneeName,
                              recording: update.task.recordingTitle,
                          })
                        : i18n("From {recording}", {
                              recording: update.task.recordingTitle,
                          })}
                </span>
                {evidence}
                <ProvenanceNote provenance={update.evidenceProvenance} />
            </div>
        </div>
    );
}
