"use client";

import {
    ListChecks,
    Loader2,
    MessageSquareText,
    Pencil,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import {
    type ReactNode,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { MarkdownActions } from "@/components/dashboard/markdown-actions";
import { HelpLink } from "@/components/help/help-button";
import { Markdown } from "@/components/markdown";
import { RecordingAgendaContext } from "@/components/meetings/recording-agenda-context";
import {
    WorkflowWidget,
    WorkflowWidgetLine,
    WorkflowWidgetRunLine,
} from "@/components/pipeline/workflow-widget";
import { SourceSwitcher } from "@/components/source-switcher";
import { SummaryEditor } from "@/components/summary/summary-editor";
import { SummaryRemarksDialog } from "@/components/summary/summary-remarks-dialog";
import type { SpeakerChoice } from "@/components/tasks/assignee-picker";
import { RecordingTasks } from "@/components/tasks/recording-tasks";
import { TaskReviewLink } from "@/components/tasks/task-review-dialog";
import { useRecordingTasks } from "@/components/tasks/use-recording-tasks";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ActionTooltip } from "@/components/ui/tooltip";
import {
    type SummarySource,
    type SummaryVersion,
    useTranscriptionSummary,
} from "@/hooks/use-transcription-summary";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import {
    inferSummarySpeakerNumberOffset,
    storeEditedSpeakerReferences,
    summarySpeakerReferencesForEditor,
} from "@/lib/knowledge/speaker-references";
import {
    isWorkflowWidgetLineVisible,
    type WorkflowWidgetState,
} from "@/lib/pipeline/workflow-widgets";
import type { RecordingView } from "@/lib/sharing/view";
import { describeMultiPass } from "@/lib/summary/multi-pass";
import { formatElapsed } from "@/lib/summary/progress-stream";

export type SummaryLearnHold = "running" | "correcting" | "review" | null;

interface SummaryWidgetProps {
    itemId: string;
    kind: "audio" | "mail";
    canChange: boolean;
    contentText?: string | null;
    canSummarize?: boolean;
    view?: RecordingView;
    source?: SummarySource;
    canSwitchSource?: boolean;
    onSourceChange?: (source: SummarySource) => void;
    sourceLabel?: string;
    speakerAttributions?: SpeakerAttributions;
    speakerLabels?: readonly string[];
    widget?: WorkflowWidgetState;
    taskWidget?: WorkflowWidgetState;
    workflowVisible: boolean;
    profileName?: string;
    widgetId: string;
    taskWidgetId: string;
    learnHold?: SummaryLearnHold;
    refreshKey?: string | number;
    onResummarizeReady?: (
        action: { run: () => void; disabled: boolean } | null,
    ) => void;
}

/** One summary body and action set for recordings and mail. */
export function SummaryWidget({
    itemId,
    kind,
    canChange,
    contentText,
    canSummarize = Boolean(contentText),
    view,
    source = "riffado",
    canSwitchSource = false,
    onSourceChange,
    sourceLabel,
    speakerAttributions = {},
    speakerLabels = [],
    widget,
    taskWidget,
    workflowVisible,
    profileName,
    widgetId,
    taskWidgetId,
    learnHold = null,
    refreshKey = 0,
    onResummarizeReady,
}: SummaryWidgetProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const [editing, setEditing] = useState<
        (SummaryVersion & { summary: string; keyPoints: string[] }) | null
    >(null);
    const [remarksOpen, setRemarksOpen] = useState(false);
    const [confirmRun, setConfirmRun] = useState<
        (SummaryVersion & { profileId?: string }) | null
    >(null);
    const {
        summaryData,
        agendaPresence,
        summaryLoaded = true,
        isSummarizing,
        summaryProgress,
        summaryElapsedMs,
        summaryExpanded,
        setSummaryExpanded,
        summaryProfileId = "",
        setSummaryProfileId,
        summaryProfileOptions = [],
        summaryProfilesLoading = false,
        handleSummarize,
        saveSummary,
        recheckSummary,
    } = useTranscriptionSummary({
        recordingId: itemId,
        summarySource: source,
        transcriptionText: contentText,
        view,
        profileChannel: kind,
    });
    const contextKey = `${itemId}:${source}:${view ?? "private"}`;
    const previousContext = useRef(contextKey);
    useEffect(() => {
        if (previousContext.current === contextKey) return;
        previousContext.current = contextKey;
        setEditing(null);
        setRemarksOpen(false);
        setConfirmRun(null);
    }, [contextKey]);
    const [workflowExpanded, setWorkflowExpanded] = useState(false);
    const [profileEditing, setProfileEditing] = useState(false);
    const previousRefreshKey = useRef(refreshKey);
    useEffect(() => {
        if (previousRefreshKey.current === refreshKey) return;
        previousRefreshKey.current = refreshKey;
        recheckSummary();
    }, [recheckSummary, refreshKey]);

    const pipelineWorking = Boolean(
        widget?.active && widget.tone === "working",
    );
    const hasSummary = Boolean(summaryData?.summary);
    const working = isSummarizing || (pipelineWorking && !hasSummary);
    const summaryOpen = workflowVisible
        ? !(widget?.collapsed ?? false) || workflowExpanded
        : summaryExpanded;
    const summaryLine = isWorkflowWidgetLineVisible({
        workflowVisible,
        collapsed: widget?.collapsed ?? false,
        expanded: workflowExpanded,
        working,
        frame: widget?.frame ?? "inline",
    });
    const tone = widget?.tone ?? "quiet";
    const requestSummary = (profileId?: string) => {
        if (editing) return;
        if (summaryData?.editedAt)
            setConfirmRun({
                profileId,
                summaryId: summaryData.summaryId ?? "",
                revision: summaryData.revision ?? 0,
            });
        else void handleSummarize(profileId);
    };
    const runSummary = () => requestSummary();
    const canCorrect =
        canChange &&
        (view ?? "private") === "private" &&
        source === "riffado" &&
        hasSummary &&
        summaryData?.canEditSummary !== false;

    const cannotSummarize =
        !canChange ||
        editing !== null ||
        working ||
        !summaryLoaded ||
        summaryProfilesLoading ||
        !summaryProfileId ||
        !canSummarize ||
        source !== "riffado";
    const reportAgendaSummary = useContext(RecordingAgendaContext);
    const summarize = useRef(runSummary);
    useEffect(() => {
        summarize.current = runSummary;
    });
    useEffect(() => {
        onResummarizeReady?.({
            run: () => void summarize.current(),
            disabled: cannotSummarize,
        });
        return () => onResummarizeReady?.(null);
    }, [cannotSummarize, onResummarizeReady]);

    useEffect(() => {
        if (!summaryLoaded || kind !== "audio") return;
        reportAgendaSummary?.({
            itemId,
            presence: agendaPresence,
            hasSummary,
            working,
            run: () => void summarize.current(),
            disabled: cannotSummarize,
        });
        return () => reportAgendaSummary?.(null);
    }, [
        reportAgendaSummary,
        summaryLoaded,
        kind,
        itemId,
        agendaPresence,
        hasSummary,
        working,
        cannotSummarize,
    ]);

    const summaryStatusLabel = !summaryProgress
        ? i18n("Generating summary…")
        : summaryProgress.phase === "merging"
          ? i18n("Merging {count, plural, one {# pass} other {# passes}}…", {
                count: summaryProgress.total,
            })
          : i18n("Summarizing — {completed}/{total} passes", {
                completed: String(summaryProgress.completed),
                total: String(summaryProgress.total),
            });
    const summaryStatus =
        summaryElapsedMs > 0
            ? `${summaryStatusLabel} · ${formatElapsed(summaryElapsedMs)}`
            : summaryStatusLabel;

    const baseMultiPassBadge = describeMultiPass(summaryData?.multiPass);
    const multiPassBadge = (() => {
        const provenance = summaryData?.multiPass;
        if (!baseMultiPassBadge || !provenance) return null;
        const { roundsRequested, passesUsed, merged } = provenance;
        let title: string;
        if (merged && passesUsed === roundsRequested) {
            title = i18n("{used} of {requested} passes merged", {
                used: String(passesUsed),
                requested: String(roundsRequested),
            });
        } else if (passesUsed === 0) {
            title = i18n(
                "No pass returned usable output; showing the raw reply of {requested}.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged && passesUsed === 1) {
            title = i18n(
                "Only 1 of {requested} passes succeeded, so it is shown unmerged.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged) {
            title = i18n(
                "{used} of {requested} passes succeeded, but the merge failed; showing the most complete single pass.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        } else {
            title = i18n(
                "{used} of {requested} passes succeeded and were merged.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        }
        return {
            ...baseMultiPassBadge,
            label: i18n("multi-pass · {passes}", {
                passes:
                    passesUsed === roundsRequested
                        ? String(roundsRequested)
                        : `${passesUsed}/${roundsRequested}`,
            }),
            title,
        };
    })();

    const summarySpeakerNumberOffset = useMemo(() => {
        if (!summaryData) return 0;
        return (
            summaryData.speakerNumberOffset ??
            inferSummarySpeakerNumberOffset(
                [
                    summaryData.summary,
                    ...(summaryData.keyPoints ?? []),
                    ...(summaryData.actionItems ?? []),
                ].join("\n"),
                speakerLabels,
            )
        );
    }, [speakerLabels, summaryData]);
    const taskSpeakers = useMemo<SpeakerChoice[]>(() => {
        const seen = new Map<string, SpeakerChoice>();
        for (const attribution of Object.values(speakerAttributions)) {
            seen.set(attribution.personId, {
                personId: attribution.personId,
                name: attribution.name,
            });
        }
        return [...seen.values()];
    }, [speakerAttributions]);

    const [summariesMade, setSummariesMade] = useState(0);
    const wasSummarizing = useRef(false);
    useEffect(() => {
        if (wasSummarizing.current && !isSummarizing) {
            setSummariesMade((count) => count + 1);
            recheckSummary();
        }
        wasSummarizing.current = isSummarizing;
    }, [isSummarizing, recheckSummary]);
    const taskState = useRecordingTasks(itemId, `${source}:${summariesMade}`);

    const selectedProfileName = summaryProfileOptions.find(
        (profile) => profile.id === summaryProfileId,
    )?.name;
    const profileHidden = summaryData?.profileVisibility === "hidden";
    const displayedProfileName = profileHidden
        ? null
        : (summaryData?.profileName ??
          (canChange ? (selectedProfileName ?? profileName) : null));
    const lineFacts = working
        ? i18n("Generating the summary")
        : ((canChange && !profileHidden ? profileName : null) ??
          displayedProfileName ??
          (source === "plaud" ? "Plaud" : sourceLabel));
    const lineProps = {
        title: i18n("Summary"),
        facts: lineFacts,
        icon: <ListChecks className="size-4" />,
        tone,
    };

    const taskReview = taskWidget?.visible !== false && (
        <TaskReviewLink
            state={taskState}
            speakers={taskSpeakers}
            organizationOnly={view === "org"}
            frame={taskWidget?.frame ?? "dialog"}
            widgetId={taskWidgetId}
            showTrigger={false}
            allowAdd={hasSummary}
        />
    );

    const runsFromLine =
        summaryLine &&
        summaryLoaded &&
        canChange &&
        !working &&
        !hasSummary &&
        source === "riffado";
    const runFromLineDisabled = summaryProfilesLoading || !canSummarize;
    let line: ReactNode;
    if (runsFromLine) {
        line = (
            <WorkflowWidgetRunLine
                {...lineProps}
                runLabel={i18n("Summarize")}
                onRun={runSummary}
                disabled={runFromLineDisabled}
            />
        );
    } else if (summaryLine) {
        line = (
            <WorkflowWidgetLine
                {...lineProps}
                working={working}
                expanded={working ? undefined : false}
                onExpand={working ? undefined : () => setWorkflowExpanded(true)}
                expandLabel={working ? undefined : i18n("View summary")}
                onOpen={() => setWorkflowExpanded(true)}
            />
        );
    }

    const headerActions = (
        <div className="flex shrink-0 items-center justify-end gap-1">
            {source === "riffado" && canChange && (
                <ActionTooltip
                    label={
                        working
                            ? i18n("Generating…")
                            : hasSummary
                              ? i18n("Re-summarize")
                              : i18n("Summarize")
                    }
                >
                    <Button
                        aria-label={
                            working
                                ? i18n("Generating…")
                                : hasSummary
                                  ? i18n("Re-summarize")
                                  : i18n("Summarize")
                        }
                        onClick={runSummary}
                        size="icon-sm"
                        variant="ghost"
                        disabled={
                            working ||
                            !summaryLoaded ||
                            summaryProfilesLoading ||
                            !summaryProfileId ||
                            !canSummarize
                        }
                    >
                        {working ? (
                            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                        ) : hasSummary ? (
                            <RefreshCw className="size-4" />
                        ) : (
                            <Sparkles className="size-4" />
                        )}
                    </Button>
                </ActionTooltip>
            )}
            {canCorrect && (
                <>
                    <ActionTooltip label={i18n("Edit summary")}>
                        <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={i18n("Edit summary")}
                            disabled={working}
                            onClick={() =>
                                setEditing({
                                    summaryId: summaryData?.summaryId ?? "",
                                    revision: summaryData?.revision ?? 0,
                                    summary: summarySpeakerReferencesForEditor(
                                        summaryData?.summary ?? "",
                                        speakerAttributions,
                                        summarySpeakerNumberOffset,
                                    ),
                                    keyPoints: (
                                        summaryData?.keyPoints ?? []
                                    ).map((point) =>
                                        summarySpeakerReferencesForEditor(
                                            point,
                                            speakerAttributions,
                                            summarySpeakerNumberOffset,
                                        ),
                                    ),
                                })
                            }
                        >
                            <Pencil className="size-4" />
                        </Button>
                    </ActionTooltip>
                    <ActionTooltip label={i18n("Summary remarks")}>
                        <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={i18n("Summary remarks")}
                            disabled={working}
                            onClick={() => setRemarksOpen(true)}
                        >
                            <MessageSquareText className="size-4" />
                        </Button>
                    </ActionTooltip>
                </>
            )}
            {canSwitchSource && onSourceChange && (
                <SourceSwitcher
                    compact
                    ariaLabel={i18n("Summary source")}
                    sources={["plaud", "riffado"]}
                    value={source}
                    onSelect={(next) =>
                        onSourceChange(next === "plaud" ? "plaud" : "riffado")
                    }
                />
            )}
            {hasSummary && (
                <MarkdownActions
                    recordingId={itemId}
                    kind="summary"
                    source={source}
                    view={view}
                />
            )}
        </div>
    );

    let contentNote: string | null = null;
    if (summaryData?.olderContent) {
        contentNote =
            kind === "mail"
                ? i18n("Made from an earlier version of the message")
                : i18n("Made from an earlier transcript");
    } else if (summaryData?.stale) {
        contentNote = i18n("May contain stale names or terms");
    }

    let summaryContent: ReactNode;
    if (editing) {
        summaryContent = (
            <SummaryEditor
                key={contextKey}
                summary={editing.summary}
                keyPoints={editing.keyPoints}
                onCancel={() => setEditing(null)}
                onSave={(text, points) =>
                    saveSummary(
                        storeEditedSpeakerReferences(text),
                        points.map(storeEditedSpeakerReferences),
                        {
                            summaryId: editing.summaryId,
                            revision: editing.revision,
                        },
                    )
                }
            />
        );
    } else if (!summaryLoaded) {
        summaryContent = (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {i18n("Loading…")}
            </p>
        );
    } else if (working) {
        summaryContent = (
            <div className="flex flex-col items-center justify-center py-8">
                <Loader2 className="mb-4 size-8 animate-spin text-primary motion-reduce:animate-none" />
                <p className="text-sm text-muted-foreground">{summaryStatus}</p>
            </div>
        );
    } else if (hasSummary && summaryData) {
        summaryContent = (
            <div className="space-y-4">
                <section
                    aria-label={i18n("Summary content")}
                    className="max-h-96 space-y-4 overflow-y-auto rounded-lg bg-muted p-4 text-sm"
                >
                    <div>
                        <Markdown
                            speakerAttributions={speakerAttributions}
                            speakerNumberOffset={summarySpeakerNumberOffset}
                        >
                            {summaryData.summary ?? ""}
                        </Markdown>
                    </div>
                    {(summaryData.keyPoints?.length ?? 0) > 0 && (
                        <div>
                            <h4 className="mb-2 font-semibold">
                                {i18n("Key Points")}
                            </h4>
                            <ul className="space-y-1">
                                {summaryData.keyPoints?.map((point) => (
                                    <li
                                        key={`kp-${point.slice(0, 32)}`}
                                        className="flex items-start gap-2 text-sm text-muted-foreground"
                                    >
                                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                                        <Markdown
                                            inline
                                            speakerAttributions={
                                                speakerAttributions
                                            }
                                            speakerNumberOffset={
                                                summarySpeakerNumberOffset
                                            }
                                        >
                                            {point}
                                        </Markdown>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </section>
            </div>
        );
    } else {
        let empty = i18n("No summary yet.");
        if (canChange && source === "plaud") {
            empty = i18n(
                "No Plaud summary has been imported. It will appear after Plaud sync when available.",
            );
        } else if (canChange && contentText && learnHold === "running") {
            empty =
                kind === "mail"
                    ? i18n(
                          'The summary waits while Learn checks the message, then starts by itself. Click "Summarize" to make it now.',
                      )
                    : i18n(
                          'The summary waits while Learn checks the transcript, then starts by itself. Click "Summarize" to make it now.',
                      );
        } else if (canChange && contentText && learnHold === "correcting") {
            empty =
                kind === "mail"
                    ? i18n(
                          'The summary waits while Learn corrects names and terms in the message, then starts by itself. Click "Summarize" to make it now.',
                      )
                    : i18n(
                          'The summary waits while Learn corrects the transcript, then starts by itself. Click "Summarize" to make it now.',
                      );
        } else if (canChange && contentText && learnHold === "review") {
            empty =
                kind === "mail"
                    ? i18n(
                          'The summary waits for your Learn review, so it reads the corrected message. Finish the review, or click "Summarize" to make it now.',
                      )
                    : i18n(
                          'The summary waits for your Learn review, so it reads the corrected transcript. Finish the review, or click "Summarize" to make it now.',
                      );
        } else if (canChange && contentText) {
            empty = i18n(
                'No custom summary yet. Click "Summarize" to generate one.',
            );
        } else if (canChange && kind === "audio") {
            empty = i18n(
                "A custom transcript is required before generating a custom summary.",
            );
        }
        summaryContent = (
            <div className="flex flex-col items-center justify-center py-8 text-center">
                <ListChecks className="mb-3 size-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{empty}</p>
                {source === "riffado" && canChange && (
                    <Button
                        className="mt-4"
                        size="sm"
                        disabled={cannotSummarize}
                        onClick={runSummary}
                    >
                        <Sparkles className="size-4" />
                        {i18n("Summarize")}
                    </Button>
                )}
            </div>
        );
    }

    const actionItemFallback =
        summaryData?.actionItems && summaryData.actionItems.length > 0 ? (
            <div>
                <h4 className="mb-2 text-sm font-medium">
                    {i18n("Action Items")}
                </h4>
                <ul className="space-y-1">
                    {summaryData.actionItems.map((item) => (
                        <li
                            key={`ai-${item.slice(0, 32)}`}
                            className="flex items-start gap-2 text-sm text-muted-foreground"
                        >
                            <ListChecks className="mt-0.5 size-3.5 shrink-0 text-primary" />
                            <Markdown
                                inline
                                speakerAttributions={speakerAttributions}
                                speakerNumberOffset={summarySpeakerNumberOffset}
                            >
                                {item}
                            </Markdown>
                        </li>
                    ))}
                </ul>
            </div>
        ) : null;

    return (
        <>
            <WorkflowWidget
                id={widgetId}
                frame="inline"
                collapsed={!editing && hasSummary && !summaryOpen}
                inlineLine={editing ? undefined : line}
                tone={tone}
                onOpenChange={(next) => {
                    if (next && runsFromLine && !runFromLineDisabled) {
                        runSummary();
                    }
                    if (workflowVisible) setWorkflowExpanded(next);
                    else setSummaryExpanded(next);
                }}
                title={i18n("Summary")}
                helpLink={
                    <HelpLink topic="summaries" label={i18n("summaries")} />
                }
                onCollapse={
                    hasSummary && !editing
                        ? () => {
                              if (workflowVisible) setWorkflowExpanded(false);
                              else setSummaryExpanded(!summaryExpanded);
                          }
                        : undefined
                }
                collapseLabel={i18n("Collapse summary")}
                expandLabel={i18n("Expand summary")}
                headerAction={
                    editing ? (
                        <span className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Pencil className="size-3.5" />
                            {i18n("Editing summary")}
                        </span>
                    ) : (
                        headerActions
                    )
                }
                footer={
                    editing
                        ? undefined
                        : {
                              status: (
                                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                      {kind === "audio" && (
                                          <span className="rounded bg-muted px-2 py-0.5 font-medium">
                                              {source === "plaud"
                                                  ? "Plaud"
                                                  : i18n("Custom")}
                                          </span>
                                      )}
                                      {summaryData?.editedAt && (
                                          <ActionTooltip
                                              label={i18n(
                                                  "Edited by {name} on {date}",
                                                  {
                                                      name:
                                                          summaryData.editedByName ??
                                                          i18n(
                                                              "Unknown author",
                                                          ),
                                                      date: new Date(
                                                          summaryData.editedAt,
                                                      ).toLocaleString(locale),
                                                  },
                                              )}
                                          >
                                              <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-medium">
                                                  <Pencil className="size-3" />
                                                  {i18n("Hand-edited")}
                                              </span>
                                          </ActionTooltip>
                                      )}
                                      {summaryData?.correctedWithRemarks &&
                                          (canCorrect ? (
                                              <button
                                                  type="button"
                                                  disabled={working}
                                                  className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 hover:bg-accent"
                                                  onClick={() =>
                                                      setRemarksOpen(true)
                                                  }
                                              >
                                                  <MessageSquareText className="size-3" />
                                                  {i18n(
                                                      "From remarks · {count}",
                                                      {
                                                          count: String(
                                                              summaryData.remarksAppliedCount ??
                                                                  0,
                                                          ),
                                                      },
                                                  )}
                                              </button>
                                          ) : (
                                              <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-medium">
                                                  <MessageSquareText className="size-3" />
                                                  {i18n(
                                                      "Corrected from remarks",
                                                  )}
                                              </span>
                                          ))}
                                      {summaryData?.provider && (
                                          <span className="rounded bg-muted px-2 py-0.5">
                                              {summaryData?.provider}
                                          </span>
                                      )}
                                      {summaryData?.model && (
                                          <span className="rounded bg-muted px-2 py-0.5 font-mono">
                                              {summaryData?.model}
                                          </span>
                                      )}
                                      {multiPassBadge && (
                                          <span
                                              className={
                                                  multiPassBadge.degraded
                                                      ? "rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400"
                                                      : "rounded bg-muted px-2 py-0.5"
                                              }
                                              title={multiPassBadge.title}
                                          >
                                              {multiPassBadge.label}
                                          </span>
                                      )}
                                      {contentNote && source === "riffado" && (
                                          <span className="flex items-center gap-2 rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                                              {contentNote}
                                              {canChange && (
                                                  <button
                                                      type="button"
                                                      className="font-medium underline-offset-2 hover:underline"
                                                      onClick={runSummary}
                                                  >
                                                      {i18n("Regenerate")}
                                                  </button>
                                              )}
                                          </span>
                                      )}
                                      {summaryData?.scopeChanged &&
                                          source === "riffado" && (
                                              <span className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                                                  {i18n(
                                                      "Folders changed since this summary:",
                                                  )}
                                                  {canChange && (
                                                      <button
                                                          type="button"
                                                          className="font-medium underline-offset-2 hover:underline"
                                                          onClick={runSummary}
                                                      >
                                                          {i18n(
                                                              "Match tasks again",
                                                          )}
                                                      </button>
                                                  )}
                                              </span>
                                          )}

                                      {source === "riffado" &&
                                          displayedProfileName && (
                                              <span className="inline-flex items-center gap-1">
                                                  {i18n("Profile")}
                                                  {profileEditing &&
                                                  canChange ? (
                                                      <Select
                                                          open
                                                          onOpenChange={(
                                                              next,
                                                          ) => {
                                                              if (!next)
                                                                  setProfileEditing(
                                                                      false,
                                                                  );
                                                          }}
                                                          value={
                                                              summaryData?.profileId ??
                                                              summaryProfileId
                                                          }
                                                          onValueChange={(
                                                              next,
                                                          ) => {
                                                              setProfileEditing(
                                                                  false,
                                                              );
                                                              if (
                                                                  next ===
                                                                  (summaryData?.profileId ??
                                                                      summaryProfileId)
                                                              )
                                                                  return;
                                                              setSummaryProfileId(
                                                                  next,
                                                              );
                                                              if (hasSummary)
                                                                  requestSummary(
                                                                      next,
                                                                  );
                                                          }}
                                                      >
                                                          <SelectTrigger
                                                              className="h-7 w-auto text-xs"
                                                              aria-label={i18n(
                                                                  "Processing profile",
                                                              )}
                                                          >
                                                              <SelectValue />
                                                          </SelectTrigger>
                                                          <SelectContent>
                                                              {summaryProfileOptions.map(
                                                                  (profile) => (
                                                                      <SelectItem
                                                                          key={
                                                                              profile.id
                                                                          }
                                                                          value={
                                                                              profile.id
                                                                          }
                                                                      >
                                                                          {
                                                                              profile.name
                                                                          }
                                                                      </SelectItem>
                                                                  ),
                                                              )}
                                                          </SelectContent>
                                                      </Select>
                                                  ) : (
                                                      <>
                                                          {displayedProfileName && (
                                                              <span>
                                                                  {
                                                                      displayedProfileName
                                                                  }
                                                              </span>
                                                          )}
                                                          {canChange &&
                                                              summaryProfileOptions.length >
                                                                  0 && (
                                                                  <ActionTooltip
                                                                      label={i18n(
                                                                          "Change summary profile",
                                                                      )}
                                                                  >
                                                                      <Button
                                                                          type="button"
                                                                          variant="ghost"
                                                                          size="icon-sm"
                                                                          className="size-6"
                                                                          disabled={
                                                                              working ||
                                                                              summaryProfilesLoading
                                                                          }
                                                                          aria-label={i18n(
                                                                              "Change summary profile",
                                                                          )}
                                                                          onClick={() =>
                                                                              setProfileEditing(
                                                                                  true,
                                                                              )
                                                                          }
                                                                      >
                                                                          <Pencil className="size-3" />
                                                                      </Button>
                                                                  </ActionTooltip>
                                                              )}
                                                      </>
                                                  )}
                                              </span>
                                          )}
                                  </div>
                              ),
                              actions: null,
                          }
                }
            >
                <div className="space-y-4">
                    {summaryContent}
                    {!editing && (
                        <RecordingTasks
                            state={taskState}
                            speakers={taskSpeakers}
                            organizationOnly={view === "org"}
                            fallback={actionItemFallback}
                            allowAdd={hasSummary}
                        />
                    )}
                </div>
            </WorkflowWidget>
            <Dialog
                open={confirmRun !== null}
                onOpenChange={(open) => {
                    if (!open) setConfirmRun(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{i18n("Summarize again?")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "You edited this summary by hand. A new summary replaces those edits. Stored remarks still apply.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "To correct part of it, write a remark. The model revises the edited text and keeps the hand-edited marker.",
                        )}
                    </p>
                    <DialogFooter className="sm:justify-between">
                        {canCorrect && (
                            <Button
                                type="button"
                                variant="link"
                                onClick={() => {
                                    setConfirmRun(null);
                                    setRemarksOpen(true);
                                }}
                            >
                                {i18n("Write a remark")}
                            </Button>
                        )}
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setConfirmRun(null)}
                            >
                                {i18n("Cancel")}
                            </Button>
                            <Button
                                type="button"
                                onClick={() => {
                                    const confirmed = confirmRun;
                                    setConfirmRun(null);
                                    if (confirmed)
                                        void handleSummarize(
                                            confirmed.profileId,
                                            {
                                                replaceEdited: true,
                                                summaryId: confirmed.summaryId,
                                                revision: confirmed.revision,
                                            },
                                        );
                                }}
                            >
                                {i18n("Re-summarize")}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {remarksOpen && canCorrect && (
                <SummaryRemarksDialog
                    key={itemId}
                    itemId={itemId}
                    profileId={summaryProfileId}
                    onClose={() => setRemarksOpen(false)}
                    onRun={() =>
                        void handleSummarize(undefined, {
                            reviseWithRemarks: true,
                            summaryId: summaryData?.summaryId,
                            revision: summaryData?.revision ?? 0,
                            onSuccess: () =>
                                toast.success(
                                    i18n(
                                        "The summary is corrected from your remarks.",
                                    ),
                                ),
                        })
                    }
                />
            )}
            {taskReview}
        </>
    );
}
