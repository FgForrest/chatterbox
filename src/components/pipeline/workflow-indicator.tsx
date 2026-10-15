"use client";

import {
    Check,
    CircleDashed,
    CircleX,
    Clock3,
    Loader2,
    Minus,
    TriangleAlert,
    X,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    CategorizePanel,
    type CategorizeSubmission,
} from "@/components/pipeline/categorize-panel";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { PhaseName, PhaseRecord, PhaseState } from "@/lib/pipeline/types";

export type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

interface WorkflowIndicatorProps {
    itemId?: string;
    initialData?: ItemProcessingPresentation | null;
    onTranscribe?: () => void;
    onLearn?: () => void;
    onSummary?: () => void;
    onReviewLearn?: () => void;
    onReviewTasks?: () => void;
    onChanged?: () => void;
}

interface DisplayPhase {
    name: PhaseName;
    state: PhaseState | "manual";
    record?: PhaseRecord;
}

function stateIcon(state: DisplayPhase["state"]) {
    const className = "size-4 shrink-0";
    switch (state) {
        case "done":
            return <Check className={className} aria-hidden />;
        case "running":
            return (
                <Loader2 className={`${className} animate-spin`} aria-hidden />
            );
        case "waiting":
            return <Clock3 className={className} aria-hidden />;
        case "failed":
            return <CircleX className={className} aria-hidden />;
        case "outdated":
            return <TriangleAlert className={className} aria-hidden />;
        case "skipped":
        case "manual":
            return <Minus className={className} aria-hidden />;
        case "not_processed":
            return <TriangleAlert className={className} aria-hidden />;
        default:
            return <CircleDashed className={className} aria-hidden />;
    }
}

export function WorkflowIndicator({
    itemId,
    initialData,
    onTranscribe,
    onLearn,
    onSummary,
    onReviewLearn,
    onReviewTasks,
    onChanged,
}: WorkflowIndicatorProps) {
    const i18n = useExtracted();
    const [data, setData] = useState(initialData ?? null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [panelData, setPanelData] =
        useState<CategorizationPanelPresentation | null>(null);
    const [panelLoading, setPanelLoading] = useState(false);
    const [processingAgain, setProcessingAgain] = useState(false);
    const panelRequest = useRef<Promise<void> | null>(null);
    const activeItemId = data?.itemId;

    useEffect(() => setData(initialData ?? null), [initialData]);

    useEffect(() => {
        setPanelData((current) =>
            current?.itemId === activeItemId ? current : null,
        );
        panelRequest.current = null;
    }, [activeItemId]);

    const load = useCallback(
        async (targetId: string | undefined, kind: "audio" | "mail") => {
            if (!targetId) return;
            const url =
                kind === "mail"
                    ? `/api/mail/${encodeURIComponent(targetId)}`
                    : `/api/recordings/${encodeURIComponent(targetId)}?processing=1`;
            try {
                const response = await fetch(url);
                if (!response.ok) return;
                const body = (await response.clone().json()) as {
                    processing?: ItemProcessingPresentation | null;
                };
                setData(body.processing ?? null);
            } catch {}
        },
        [],
    );

    useEffect(() => {
        if (initialData !== undefined) return;
        void load(itemId, "audio");
    }, [initialData, itemId, load]);

    const loadPanel = useCallback(() => {
        if (!data || panelData || panelRequest.current) return;
        setPanelLoading(true);
        const request = fetch(
            `/api/recordings/${encodeURIComponent(data.itemId)}/categorize`,
        )
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                setPanelData(
                    (await response.json()) as CategorizationPanelPresentation,
                );
            })
            .catch(() => {
                toast.error(i18n("The filing options could not be loaded."));
            })
            .finally(() => {
                panelRequest.current = null;
                setPanelLoading(false);
            });
        panelRequest.current = request;
    }, [data, i18n, panelData]);

    const openPanel = useCallback(() => {
        setPanelOpen(true);
        loadPanel();
    }, [loadPanel]);

    const phases = useMemo<DisplayPhase[]>(() => {
        if (!data || data.legacy) return [];
        const names: PhaseName[] = [
            "categorize",
            ...(data.kind === "audio" ? (["transcribe"] as const) : []),
            "learn",
            "summary",
            "taskReview",
            ...(data.intents.length > 0 ? (["share"] as const) : []),
        ];
        return names.map((name) => {
            const record = data.phases[name];
            if (record?.state === "outdated") {
                return { name, state: "outdated" as const, record };
            }
            if (
                name === "transcribe" ||
                name === "learn" ||
                name === "summary"
            ) {
                const output =
                    name === "transcribe"
                        ? data.outputs.transcript
                        : name === "learn"
                          ? data.outputs.learn
                          : data.outputs.summary;
                const automatic =
                    !data.manualOnly &&
                    (data.profile?.automatic[name] ?? false);
                if (data.manualOnly || (data.profile !== null && !automatic)) {
                    return {
                        name,
                        state: output ? ("done" as const) : ("manual" as const),
                        record,
                    };
                }
            }
            return { name, state: record?.state ?? "pending", record };
        });
    }, [data]);

    if (!data) return null;

    const phaseLabel = (name: PhaseName) => {
        switch (name) {
            case "categorize":
                return i18n("Categorize");
            case "transcribe":
                return i18n("Transcribe");
            case "learn":
                return i18n("Learn");
            case "summary":
                return i18n("Summary");
            case "taskReview":
                return i18n("Task review");
            case "share":
                return i18n("Share");
        }
    };
    const stateLabel = (phase: DisplayPhase) => {
        if (
            phase.name === "categorize" &&
            phase.state === "waiting" &&
            phase.record?.reason === "needs_folder"
        ) {
            return i18n("Waiting for you to file it");
        }
        if (
            phase.name === "learn" &&
            phase.record?.reason === "review_pending_timeout"
        ) {
            return i18n("Learn review pending; summary made without it");
        }
        switch (phase.state) {
            case "pending":
                return i18n("Pending");
            case "waiting":
                return i18n("Waiting");
            case "running":
                return i18n("Running");
            case "done":
                return i18n("Done");
            case "skipped":
                return i18n("Skipped");
            case "failed":
                return i18n("Failed");
            case "outdated":
                return i18n("Outdated");
            case "not_processed":
                return i18n("Not processed");
            case "manual":
                return i18n("By hand");
        }
    };
    const skippedReason = (reason: string | undefined) => {
        switch (reason) {
            case "manual_only":
            case "profile_off":
            case "disabled":
                return i18n("This step is not automatic for this profile.");
            case "hosted":
                return i18n("Learn is available only when self-hosted.");
            case "no_provider":
                return i18n("No provider is available for this step.");
            case "no_timings":
                return i18n("The transcript has no timings.");
            case "content_reaped":
            case "audio_reaped":
                return i18n("The source content is no longer available.");
            case "shared":
                return i18n(
                    "This recording is shared; the Organization processes it.",
                );
            case "machine_sent":
                return i18n("Machine-sent mail is kept but not processed.");
            case "unreadable":
                return i18n("The mail content could not be read.");
            case "cancelled":
                return i18n("The intended share was cancelled.");
            default:
                return i18n("This step was skipped.");
        }
    };
    const actionFor = (phase: DisplayPhase) => {
        if (phase.name === "categorize" && phase.state === "waiting") {
            return {
                label:
                    phase.record?.reason === "needs_profile"
                        ? i18n("Choose a profile")
                        : i18n("File it"),
                action: openPanel,
            };
        }
        if (phase.name === "learn" && phase.state === "waiting") {
            return { label: i18n("Review Learn"), action: onReviewLearn };
        }
        if (phase.name === "taskReview" && phase.state === "waiting") {
            return { label: i18n("Review tasks"), action: onReviewTasks };
        }
        if (phase.state !== "manual" && phase.state !== "outdated") return null;
        if (phase.name === "transcribe") {
            return { label: i18n("Transcribe"), action: onTranscribe };
        }
        if (phase.name === "learn") {
            return { label: i18n("Learn"), action: onLearn };
        }
        if (phase.name === "summary") {
            return { label: i18n("Generate summary"), action: onSummary };
        }
        return null;
    };
    const cancelIntent = async (folderId: string) => {
        const previous = data;
        setData({
            ...data,
            intents: data.intents.filter(
                (intent) => intent.folderId !== folderId,
            ),
        });
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/intended-placements/${encodeURIComponent(folderId)}`,
                { method: "DELETE" },
            );
            if (!response.ok) throw new Error("Intent cancellation failed");
        } catch {
            setData(previous);
            toast.error(
                i18n(
                    "The intended Organization placement could not be cancelled.",
                ),
            );
            return;
        }
        toast.success(i18n("Intended Organization placement cancelled."));
        onChanged?.();
    };
    const processAgain = async () => {
        if (processingAgain) return;
        setProcessingAgain(true);
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(data.itemId)}/process-again`,
                { method: "POST" },
            );
            if (!response.ok) throw new Error(String(response.status));
            setData((current) =>
                current ? { ...current, processAgain: false } : current,
            );
            toast.success(i18n("Processing requested."));
            onChanged?.();
        } catch {
            toast.error(i18n("The item could not be processed again."));
        } finally {
            setProcessingAgain(false);
        }
    };
    const optimisticallyCategorize = (submission: CategorizeSubmission) => {
        const previous = data;
        const selected = submission.folderIds.flatMap((folderId) => {
            const folder = panelData?.folders.find(
                (candidate) => candidate.id === folderId,
            );
            return folder ? [folder] : [];
        });
        setData({
            ...data,
            manualOnly: submission.manualOnly ?? data.manualOnly,
            placements: selected.filter(
                (folder) => folder.scope === "personal",
            ),
            intents: selected
                .filter((folder) => folder.scope === "org")
                .map((folder) => ({
                    folderId: folder.id,
                    name: folder.name,
                    path: folder.path,
                })),
            phases: {
                ...data.phases,
                categorize: {
                    state: "done",
                    reason: "categorized",
                    generation: data.phases.categorize?.generation ?? 0,
                    at: new Date().toISOString(),
                },
            },
            profile: data.profile,
        });
        return () => setData(previous);
    };

    return (
        <TooltipProvider>
            <section className="space-y-3" aria-label={i18n("Workflow")}>
                <div className="flex flex-wrap items-center gap-2">
                    {data.intents.map((intent) => (
                        <span
                            key={intent.folderId}
                            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs"
                        >
                            {i18n("{folder} · shares after review", {
                                folder: intent.path,
                            })}
                            <button
                                type="button"
                                className="rounded-full p-0.5 hover:bg-muted"
                                aria-label={i18n("Cancel {folder}", {
                                    folder: intent.path,
                                })}
                                onClick={() =>
                                    void cancelIntent(intent.folderId)
                                }
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    ))}
                    {data.legacy ? (
                        <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                            {i18n("Processed before profiles")}
                        </span>
                    ) : data.profile ? (
                        <span className="rounded-full border px-2.5 py-1 text-xs">
                            {i18n("Profile")}: {data.profile.name}
                            {data.manualOnly
                                ? ` · ${i18n("Nothing automatic")}`
                                : ""}
                        </span>
                    ) : null}
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={openPanel}
                        onMouseEnter={loadPanel}
                        onFocus={loadPanel}
                        disabled={panelLoading}
                    >
                        {i18n("File it")}
                    </Button>
                    {data.processAgain && !data.manualOnly && (
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => void processAgain()}
                            disabled={processingAgain}
                        >
                            {processingAgain && (
                                <Loader2
                                    className="mr-1 size-3 animate-spin"
                                    aria-hidden
                                />
                            )}
                            {i18n("Process again")}
                        </Button>
                    )}
                </div>

                {!data.legacy && (
                    <ol className="flex flex-wrap gap-2">
                        {phases.map((phase) => {
                            const action = actionFor(phase);
                            const content = (
                                <li
                                    key={phase.name}
                                    className="flex min-h-9 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                                >
                                    {stateIcon(phase.state)}
                                    <span className="font-medium">
                                        {phaseLabel(phase.name)}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {stateLabel(phase)}
                                    </span>
                                    {action && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 px-1.5 text-xs"
                                            onClick={action.action}
                                            onMouseEnter={
                                                phase.name === "categorize"
                                                    ? loadPanel
                                                    : undefined
                                            }
                                            onFocus={
                                                phase.name === "categorize"
                                                    ? loadPanel
                                                    : undefined
                                            }
                                        >
                                            {action.label}
                                        </Button>
                                    )}
                                </li>
                            );
                            return phase.state === "skipped" ? (
                                <Tooltip key={phase.name}>
                                    <TooltipTrigger asChild>
                                        {content}
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {skippedReason(phase.record?.reason)}
                                    </TooltipContent>
                                </Tooltip>
                            ) : (
                                content
                            );
                        })}
                    </ol>
                )}
            </section>
            {panelData && (
                <CategorizePanel
                    data={panelData}
                    open={panelOpen}
                    onOpenChange={setPanelOpen}
                    onOptimisticCategorize={optimisticallyCategorize}
                    onCategorized={() => {
                        setPanelOpen(false);
                        setPanelData(null);
                        void load(data.itemId, data.kind);
                        onChanged?.();
                    }}
                />
            )}
        </TooltipProvider>
    );
}
