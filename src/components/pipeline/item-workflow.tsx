"use client";

import { FileText, Loader2, Users, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
    CategorizePanel,
    type CategorizeSubmission,
} from "@/components/pipeline/categorize-panel";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import { WorkflowStrip } from "@/components/pipeline/workflow-indicator";
import { workflowScrollBehavior } from "@/components/pipeline/workflow-widget";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useItemProcessing } from "@/hooks/use-item-processing";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { WorkflowActionCode } from "@/lib/pipeline/workflow-status";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

interface FolderActions {
    folders: RecordingFolder[];
    folderAssignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAddToFolder: (itemId: string, folderId: string) => Promise<void>;
    onRemoveFromFolder: (
        itemId: string,
        folderId: string,
        withdraw?: boolean,
    ) => Promise<void>;
    onMoveBetweenFolders?: (
        itemId: string,
        fromFolderId: string,
        toFolderId: string,
    ) => Promise<void>;
}

interface ProcessingFolderRowProps extends FolderActions {
    itemId: string;
    kind: "audio" | "mail";
    processing: ItemProcessingPresentation | null;
    panelData: CategorizationPanelPresentation | null;
    isOwn: boolean;
    canWithdraw: boolean;
    organizationOnly: boolean;
    onLoadPanel: () => void;
    onProfileChange: (choice: string) => void;
    onCancelIntent: (folderId: string) => void;
    onShareNow: () => void;
}

const MANUAL_ONLY = "__manual_only__";

/** Folder placements, intended shares, and profile choice on one header row. */
export function ProcessingFolderRow({
    itemId,
    kind,
    processing,
    panelData,
    isOwn,
    canWithdraw,
    organizationOnly,
    folders,
    folderAssignments,
    onSelectFolder,
    onAddToFolder,
    onRemoveFromFolder,
    onMoveBetweenFolders,
    onLoadPanel,
    onProfileChange,
    onCancelIntent,
    onShareNow,
}: ProcessingFolderRowProps) {
    const i18n = useExtracted();
    const profileChoice = processing?.manualOnly
        ? MANUAL_ONLY
        : (processing?.profile?.id ?? "");
    const profileChip = processing ? (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 max-w-[min(18rem,70vw)] rounded-full px-2.5 text-xs"
            onMouseEnter={onLoadPanel}
            onFocus={onLoadPanel}
            data-testid="profile-chip"
        >
            <FileText className="size-3.5" aria-hidden />
            <span className="truncate">
                {processing.legacy
                    ? i18n("Processed before profiles")
                    : processing.profile?.name}
                {!processing.legacy && processing.manualOnly
                    ? ` · ${i18n("Nothing automatic")}`
                    : ""}
            </span>
            {!processing.legacy &&
                processing.profile?.scope === "organization" && (
                    <Users
                        className="size-3.5 shrink-0 text-primary"
                        aria-label={i18n("Organization")}
                    />
                )}
        </Button>
    ) : null;
    const profileTrigger = (
        <DropdownMenuTrigger asChild>{profileChip}</DropdownMenuTrigger>
    );
    return (
        <div
            className="flex min-w-0 flex-wrap items-start gap-2"
            data-testid="processing-folder-row"
        >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <RecordingFolderTags
                    recordingId={itemId}
                    kind={kind}
                    folders={folders}
                    assignments={folderAssignments}
                    onSelectFolder={onSelectFolder}
                    onAdd={onAddToFolder}
                    onRemove={onRemoveFromFolder}
                    isOwn={isOwn}
                    canWithdraw={canWithdraw}
                    organizationOnly={organizationOnly}
                    onMove={onMoveBetweenFolders}
                />
                {!organizationOnly &&
                    processing?.intents.map((intent) => (
                        <span
                            key={intent.folderId}
                            className="inline-flex min-h-7 items-center overflow-hidden rounded-full border border-dashed border-primary/40 bg-primary/5 text-xs"
                        >
                            <span className="inline-flex items-center gap-1.5 px-2.5 text-foreground">
                                <Users
                                    className="size-3.5 text-primary"
                                    aria-label={i18n("Organization")}
                                />
                                <span>{intent.path}</span>
                            </span>
                            {intent.confirmationRequired &&
                                !intent.confirmed && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="h-7 rounded-none border-y-0 border-r-0 px-2.5 text-xs"
                                        onClick={onShareNow}
                                    >
                                        {i18n("Share now")}
                                    </Button>
                                )}
                            <button
                                type="button"
                                className="inline-flex h-7 items-center border-l border-primary/15 px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={i18n("Cancel {folder}", {
                                    folder: intent.path,
                                })}
                                onClick={() => onCancelIntent(intent.folderId)}
                            >
                                <X className="size-3.5" aria-hidden />
                            </button>
                        </span>
                    ))}
            </div>
            {!organizationOnly && processing && (
                <div className="ml-auto shrink-0 self-start">
                    {processing.legacy || processing.profile ? (
                        <DropdownMenu
                            onOpenChange={(open) => {
                                if (open) onLoadPanel();
                            }}
                        >
                            {processing.legacy ? (
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            {profileTrigger}
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            {i18n(
                                                "Choose a profile for this item. Its existing results stay unchanged.",
                                            )}
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            ) : (
                                profileTrigger
                            )}
                            <DropdownMenuContent
                                align="end"
                                className="min-w-56"
                            >
                                <DropdownMenuLabel>
                                    {i18n("Profile")}
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {panelData ? (
                                    <DropdownMenuRadioGroup
                                        value={profileChoice}
                                        onValueChange={onProfileChange}
                                    >
                                        {panelData.profiles.map((profile) => (
                                            <DropdownMenuRadioItem
                                                key={profile.id}
                                                value={profile.id}
                                            >
                                                {profile.name}
                                                {profile.scope ===
                                                    "organization" && (
                                                    <Users
                                                        className="ml-auto size-3.5 text-primary"
                                                        aria-label={i18n(
                                                            "Organization",
                                                        )}
                                                    />
                                                )}
                                            </DropdownMenuRadioItem>
                                        ))}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuRadioItem
                                            value={MANUAL_ONLY}
                                        >
                                            {i18n("Nothing automatic")}
                                        </DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                ) : (
                                    <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                                        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                                        {i18n("Loading…")}
                                    </div>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            )}
        </div>
    );
}

interface ItemWorkflowProps extends FolderActions {
    itemId: string;
    kind: "audio" | "mail";
    initialData?: ItemProcessingPresentation | null;
    isOwn?: boolean;
    canWithdraw?: boolean;
    view?: "private" | "org";
    onChanged?: () => void;
    onFolderCreated?: (folder: CreatedFolder) => void;
    onTranscribe?: (retranscribe?: boolean) => void;
    onLearn?: () => void;
    onSummary?: () => void;
    onReviewLearn?: () => void;
    onReviewTasks?: () => void;
    onProcessingChange?: (data: ItemProcessingPresentation | null) => void;
}

/** Processing strip plus the filing card or its settled folder/profile row. */
export function ItemWorkflow({
    itemId,
    kind,
    initialData,
    isOwn = true,
    canWithdraw = isOwn,
    view = "private",
    folders,
    folderAssignments,
    onSelectFolder,
    onAddToFolder,
    onRemoveFromFolder,
    onMoveBetweenFolders,
    onChanged,
    onFolderCreated,
    onTranscribe,
    onLearn,
    onSummary,
    onReviewLearn,
    onReviewTasks,
    onProcessingChange,
}: ItemWorkflowProps) {
    const i18n = useExtracted();
    const canEdit = isOwn && view !== "org";
    const processingEnabled = canEdit || view === "org";
    const { data, setData, workflow } = useItemProcessing({
        itemId,
        kind,
        view,
        initialData,
        enabled: processingEnabled,
    });
    const [panelData, setPanelData] =
        useState<CategorizationPanelPresentation | null>(null);
    const panelRequest = useRef<{ itemId: string } | null>(null);
    const filingRef = useRef<HTMLDivElement>(null);
    const pendingFilingFocus = useRef(false);
    const invalidate = useCallback(
        () => invalidateItemProcessing(itemId),
        [itemId],
    );

    useEffect(() => {
        onProcessingChange?.(data);
    }, [data, onProcessingChange]);

    useEffect(() => {
        setPanelData((current) =>
            current?.itemId === itemId ? current : null,
        );
        panelRequest.current = null;
        pendingFilingFocus.current = false;
    }, [itemId]);

    const loadPanel = useCallback(() => {
        if (!canEdit || panelData || panelRequest.current?.itemId === itemId) {
            return;
        }
        panelRequest.current = { itemId };
        void fetch(`/api/recordings/${encodeURIComponent(itemId)}/categorize`)
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                const body =
                    (await response.json()) as CategorizationPanelPresentation;
                if (panelRequest.current?.itemId === itemId) {
                    setPanelData(body);
                }
            })
            .catch(() => {
                toast.error(i18n("The filing options could not be loaded."));
            })
            .finally(() => {
                if (panelRequest.current?.itemId === itemId) {
                    panelRequest.current = null;
                }
            });
    }, [canEdit, i18n, itemId, panelData]);

    const categorizeReason = data?.phases.categorize?.reason;
    const profileReason =
        categorizeReason === "needs_profile" ||
        categorizeReason === "profile_unavailable"
            ? categorizeReason
            : undefined;
    let filingMode: "folder" | "profile" | null = null;
    if (categorizeReason === "needs_folder") filingMode = "folder";
    else if (profileReason) filingMode = "profile";

    useEffect(() => {
        if (filingMode) loadPanel();
    }, [filingMode, loadPanel]);

    const cancelIntent = useCallback(
        async (folderId: string) => {
            if (!data) return;
            const previous = data;
            setData({
                ...data,
                intents: data.intents.filter(
                    (intent) => intent.folderId !== folderId,
                ),
            });
            try {
                const response = await fetch(
                    `/api/recordings/${encodeURIComponent(itemId)}/intended-placements/${encodeURIComponent(folderId)}`,
                    { method: "DELETE" },
                );
                if (!response.ok) throw new Error(String(response.status));
                invalidate();
                onChanged?.();
            } catch {
                setData(previous);
                toast.error(
                    i18n(
                        "The intended Organization placement could not be cancelled.",
                    ),
                );
            }
        },
        [data, i18n, invalidate, itemId, onChanged, setData],
    );

    const shareNow = useCallback(async () => {
        if (!data) return;
        const previous = data;
        setData({
            ...data,
            intents: data.intents.map((intent) => ({
                ...intent,
                confirmationRequired: false,
                confirmed: true,
            })),
        });
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(itemId)}/intended-placements/confirm`,
                { method: "POST" },
            );
            if (!response.ok) throw new Error(String(response.status));
            toast.success(i18n("Sharing started."));
            invalidate();
            onChanged?.();
        } catch {
            setData(previous);
            toast.error(i18n("The item could not be shared."));
        }
    }, [data, i18n, invalidate, itemId, onChanged, setData]);

    const changeProfile = useCallback(
        async (choice: string) => {
            if (!data || !panelData) return;
            const previous = data;
            const chosen = panelData.profiles.find(
                (profile) => profile.id === choice,
            );
            const manualOnly = choice === MANUAL_ONLY;
            setData({
                ...data,
                legacy: false,
                manualOnly,
                profile: chosen
                    ? {
                          ...chosen,
                          revisionId: data.profile?.revisionId ?? "pending",
                          automatic: data.profile?.automatic ?? {
                              transcribe: false,
                              learn: false,
                              summary: false,
                          },
                      }
                    : data.profile,
            });
            const folderIds = [
                ...data.placements.map((folder) => folder.id),
                ...data.intents.map((intent) => intent.folderId),
            ];
            try {
                const response = await fetch(
                    `/api/recordings/${encodeURIComponent(itemId)}/categorize`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            folderIds,
                            ...(manualOnly
                                ? { manualOnly: true }
                                : { profileId: choice }),
                        }),
                    },
                );
                if (!response.ok) throw new Error(String(response.status));
                invalidate();
                onChanged?.();
            } catch {
                setData(previous);
                toast.error(i18n("The profile could not be changed."));
            }
        },
        [data, i18n, invalidate, itemId, onChanged, panelData, setData],
    );

    const processAgain = useCallback(async () => {
        if (!data) return;
        const previous = data;
        setData({ ...data, processAgain: false, processAgainReason: null });
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(itemId)}/process-again`,
                { method: "POST" },
            );
            if (!response.ok) throw new Error(String(response.status));
            toast.success(i18n("Processing requested."));
            invalidate();
            onChanged?.();
        } catch {
            setData(previous);
            toast.error(i18n("The item could not be processed again."));
        }
    }, [data, i18n, invalidate, itemId, onChanged, setData]);

    const optimisticCategorize = useCallback(
        (submission: CategorizeSubmission) => {
            if (!data || !panelData) return () => {};
            const previous = data;
            const selected = submission.folderIds.flatMap((folderId) => {
                const folder = panelData.folders.find(
                    (candidate) => candidate.id === folderId,
                );
                return folder ? [folder] : [];
            });
            const chosen = submission.profileId
                ? panelData.profiles.find(
                      (profile) => profile.id === submission.profileId,
                  )
                : undefined;
            const manualOnly = submission.manualOnly ?? false;
            setData({
                ...data,
                manualOnly,
                placements: selected.filter(
                    (folder) => folder.scope === "personal",
                ),
                intents: selected
                    .filter((folder) => folder.scope === "org")
                    .map((folder) => ({
                        folderId: folder.id,
                        name: folder.name,
                        path: folder.path,
                        confirmationRequired: manualOnly,
                        confirmed: false,
                    })),
                profile: chosen
                    ? {
                          ...chosen,
                          revisionId: data.profile?.revisionId ?? "pending",
                          automatic: data.profile?.automatic ?? {
                              transcribe: false,
                              learn: false,
                              summary: false,
                          },
                      }
                    : data.profile,
                phases: {
                    ...data.phases,
                    categorize: {
                        state: "done",
                        reason: "categorized",
                        generation: data.phases.categorize?.generation ?? 0,
                        at: new Date().toISOString(),
                    },
                },
            });
            return () => setData(previous);
        },
        [data, panelData, setData],
    );

    const focusFilingControl = useCallback(() => {
        const profile = filingRef.current?.querySelector<HTMLElement>(
            "[data-filing-profile]",
        );
        if (!profile) return;
        pendingFilingFocus.current = false;
        filingRef.current?.scrollIntoView({
            behavior: workflowScrollBehavior(),
            block: "start",
        });
        profile.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        if (!panelData || !pendingFilingFocus.current) return;
        const frame = window.requestAnimationFrame(focusFilingControl);
        return () => window.cancelAnimationFrame(frame);
    }, [focusFilingControl, panelData]);

    const focusFiling = useCallback(() => {
        pendingFilingFocus.current = true;
        window.requestAnimationFrame(focusFilingControl);
    }, [focusFilingControl]);

    const handleAction = (action: WorkflowActionCode) => {
        switch (action) {
            case "file":
            case "chooseProfile":
                loadPanel();
                focusFiling();
                break;
            case "reviewLearn":
                onReviewLearn?.();
                break;
            case "transcribe":
                onTranscribe?.(false);
                break;
            case "reviewTasks":
                onReviewTasks?.();
                break;
            case "shareNow":
                void shareNow();
                break;
            case "processAgain":
                void processAgain();
                break;
            case "retry": {
                const failedStep = workflow?.status?.params?.step;
                if (failedStep === "transcribe") onTranscribe?.(true);
                else if (failedStep === "learn") onLearn?.();
                else if (failedStep === "summary") onSummary?.();
                break;
            }
        }
    };

    const addToFolder = async (targetItemId: string, folderId: string) => {
        await onAddToFolder(targetItemId, folderId);
        invalidate();
    };
    const removeFromFolder = async (
        targetItemId: string,
        folderId: string,
        withdraw?: boolean,
    ) => {
        await onRemoveFromFolder(targetItemId, folderId, withdraw);
        invalidate();
    };
    const moveBetweenFolders = onMoveBetweenFolders
        ? async (
              targetItemId: string,
              fromFolderId: string,
              toFolderId: string,
          ) => {
              await onMoveBetweenFolders(
                  targetItemId,
                  fromFolderId,
                  toFolderId,
              );
              invalidate();
          }
        : undefined;

    const folderProps = {
        folders,
        folderAssignments,
        onSelectFolder,
        onAddToFolder: addToFolder,
        onRemoveFromFolder: removeFromFolder,
        onMoveBetweenFolders: moveBetweenFolders,
    };

    return (
        <>
            {processingEnabled && workflow && (
                <WorkflowStrip
                    workflow={workflow}
                    kind={kind}
                    onAction={handleAction}
                    readOnly={!canEdit}
                />
            )}
            {canEdit && filingMode ? (
                <div ref={filingRef}>
                    {panelData ? (
                        <CategorizePanel
                            data={panelData}
                            kind={kind}
                            mode={filingMode}
                            reason={profileReason}
                            onFolderCreated={onFolderCreated}
                            onTranscribe={() => onTranscribe?.(false)}
                            onOptimisticCategorize={optimisticCategorize}
                            onCategorized={() => {
                                invalidate();
                                onChanged?.();
                            }}
                        />
                    ) : (
                        <div className="flex min-h-24 items-center justify-center rounded-lg border text-sm text-muted-foreground">
                            <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
                            {i18n("Loading filing choices…")}
                        </div>
                    )}
                </div>
            ) : (
                <ProcessingFolderRow
                    itemId={itemId}
                    kind={kind}
                    processing={data}
                    panelData={panelData}
                    isOwn={isOwn}
                    canWithdraw={canWithdraw}
                    organizationOnly={view === "org"}
                    onLoadPanel={loadPanel}
                    onProfileChange={(choice) => void changeProfile(choice)}
                    onCancelIntent={(folderId) => void cancelIntent(folderId)}
                    onShareNow={() => void shareNow()}
                    {...folderProps}
                />
            )}
        </>
    );
}
