"use client";

import { FileText, Loader2, Users, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useItemDetail } from "@/components/items/item-detail-store";
import { ItemFolderSaving } from "@/components/items/item-folder-chip";
import {
    type ItemOperationResult,
    itemOperationResult,
} from "@/components/items/item-operation-queue";
import { processAgainOperation } from "@/components/items/process-again-operation";
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
import {
    shareReviewHref,
    useShareProblemMessage,
} from "@/hooks/use-share-problem-message";
import { useSkipFailedLearn } from "@/hooks/use-skip-failed-learn";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import type { WorkflowActionCode } from "@/lib/pipeline/workflow-status";
import { isShareReviewProblem } from "@/lib/sharing/share-gate";
import { withRecordingView } from "@/lib/sharing/view";
import { cn } from "@/lib/utils";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

interface FolderActions {
    canCurate?: boolean;
    onFolderCreated?: (folder: CreatedFolder) => void;
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
    canCurate,
    onFolderCreated,
}: ProcessingFolderRowProps) {
    const i18n = useExtracted();
    const detail = useItemDetail();
    const profileChoice = processing?.manualOnly
        ? MANUAL_ONLY
        : (processing?.profile?.id ?? "");
    const profileChip = processing ? (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
                "h-7 max-w-[min(18rem,70vw)] rounded-full px-2.5 text-xs",
                detail?.pendingProfile && "opacity-60",
            )}
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
            {detail?.pendingProfile && <ItemFolderSaving />}
            {!processing.legacy &&
                processing.profile?.scope === "organization" && (
                    <Users
                        className="size-3.5 shrink-0 text-organization"
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
                    canCurate={canCurate}
                    onFolderCreated={onFolderCreated}
                />
                {!organizationOnly &&
                    processing?.intents.map((intent) => (
                        <span
                            key={intent.folderId}
                            className={cn(
                                "inline-flex min-h-7 items-center overflow-hidden rounded-full border border-dashed border-organization/40 bg-organization/5 text-xs",
                                (detail?.pendingIntents ||
                                    detail?.pendingFolderIds.has(
                                        intent.folderId,
                                    )) &&
                                    "opacity-60",
                            )}
                        >
                            <span className="inline-flex items-center gap-1.5 px-2.5 text-foreground">
                                <Users
                                    className="size-3.5 text-organization"
                                    aria-label={i18n("Organization")}
                                />
                                <span>{intent.path}</span>
                            </span>
                            {(detail?.pendingIntents ||
                                detail?.pendingFolderIds.has(
                                    intent.folderId,
                                )) && <ItemFolderSaving />}
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
                                className="inline-flex h-7 items-center border-l border-organization/15 px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                                        className="ml-auto size-3.5 text-organization"
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
    isOwn?: boolean;
    canWithdraw?: boolean;
    view?: "private" | "org";
    onChanged?: () => void;
    onTranscribe?: (retranscribe?: boolean) => void;
    onLearn?: () => void;
    onSummary?: () => void;
    onReviewLearn?: () => void;
    onReviewTasks?: () => void;
}

function previewProfile(
    current: ItemProcessingPresentation,
    chosen: CategorizationPanelPresentation["profiles"][number] | undefined,
) {
    return chosen
        ? {
              ...chosen,
              revisionId: current.profile?.revisionId ?? "pending",
              automatic: current.profile?.automatic ?? {
                  transcribe: false,
                  learn: false,
                  summary: false,
              },
          }
        : current.profile;
}

async function profileFolderIds(
    itemId: string,
    projection: ItemProcessingPresentation | null,
) {
    if (projection) {
        return [
            ...new Set([
                ...projection.placements
                    .filter((folder) => folder.parentId !== null)
                    .map((folder) => folder.id),
                ...projection.intents.map((intent) => intent.folderId),
            ]),
        ];
    }
    const response = await fetch(
        `/api/recordings/${encodeURIComponent(itemId)}/categorize`,
    );
    if (!response.ok) throw new Error(String(response.status));
    const panel: CategorizationPanelPresentation = await response.json();
    return panel.selectedFolderIds;
}

/** Processing strip plus the filing card or its settled folder/profile row. */
export function ItemWorkflow({
    itemId,
    kind,
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
    canCurate,
    onTranscribe,
    onLearn,
    onSummary,
    onReviewLearn,
    onReviewTasks,
}: ItemWorkflowProps) {
    const i18n = useExtracted();
    const shareProblemMessage = useShareProblemMessage();
    const canEdit = isOwn && view !== "org";
    const { skip: skipLearn, skipping: skippingLearn } =
        useSkipFailedLearn(itemId);
    const processingEnabled = canEdit || view === "org";
    const detail = useItemDetail();
    if (!detail) throw new Error("ItemWorkflow requires ItemDetailProvider");
    const { data, enqueueOperation, workflow, refresh, stale } = detail;
    const [panelData, setPanelData] =
        useState<CategorizationPanelPresentation | null>(null);
    const foldersSignature = JSON.stringify(
        folders
            .map(({ id, parentId, name, restricted, restricting, access }) => ({
                id,
                parentId,
                name,
                restricted,
                restricting,
                access,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
    );
    const loadedFoldersSignature = useRef<string | null>(null);
    const panelRequest = useRef<{
        itemId: string;
        foldersSignature: string;
    } | null>(null);
    const filingRef = useRef<HTMLDivElement>(null);
    const pendingFilingFocus = useRef(false);
    const invalidate = useCallback(
        () => invalidateItemProcessing(itemId),
        [itemId],
    );

    useEffect(() => {
        setPanelData((current) =>
            current?.itemId === itemId ? current : null,
        );
        panelRequest.current = null;
        loadedFoldersSignature.current = null;
        pendingFilingFocus.current = false;
        setPendingFilingMode(null);
        return () => {
            panelRequest.current = null;
        };
    }, [itemId]);

    const loadPanel = useCallback(
        (force = false) => {
            if (
                !canEdit ||
                (!force &&
                    panelData?.itemId === itemId &&
                    loadedFoldersSignature.current === foldersSignature) ||
                (!force &&
                    panelRequest.current?.itemId === itemId &&
                    panelRequest.current.foldersSignature === foldersSignature)
            ) {
                return;
            }
            const request = { itemId, foldersSignature };
            panelRequest.current = request;
            void fetch(
                `/api/recordings/${encodeURIComponent(itemId)}/categorize`,
            )
                .then(async (response) => {
                    if (!response.ok) throw new Error(String(response.status));
                    const body =
                        (await response.json()) as CategorizationPanelPresentation;
                    if (
                        panelRequest.current === request &&
                        body.itemId === itemId
                    ) {
                        loadedFoldersSignature.current = foldersSignature;
                        setPanelData(body);
                    }
                })
                .catch(() => {
                    if (panelRequest.current === request) {
                        toast.error(
                            i18n("The filing options could not be loaded."),
                        );
                    }
                })
                .finally(() => {
                    if (panelRequest.current === request) {
                        panelRequest.current = null;
                    }
                });
        },
        [canEdit, foldersSignature, i18n, itemId, panelData],
    );

    const categorizeReason = data?.phases.categorize?.reason;
    const profileReason =
        categorizeReason === "needs_profile" ||
        categorizeReason === "profile_unavailable"
            ? categorizeReason
            : undefined;
    let filingMode: "folder" | "profile" | null = null;
    const [pendingFilingMode, setPendingFilingMode] = useState<
        "folder" | "profile" | null
    >(null);
    if (categorizeReason === "needs_folder") filingMode = "folder";
    else if (profileReason) filingMode = "profile";
    filingMode = pendingFilingMode ?? filingMode;

    useEffect(() => {
        if (filingMode) loadPanel();
    }, [filingMode, loadPanel]);

    const cancelIntent = async (folderId: string) => {
        try {
            await enqueueOperation({
                apply: (current) => {
                    const intents = current.intents.filter(
                        (intent) => intent.folderId !== folderId,
                    );
                    return {
                        ...current,
                        intents,
                        steps:
                            intents.length === 0 && current.intents.length > 0
                                ? {
                                      ...current.steps,
                                      share: {
                                          state: "skipped",
                                          reason: "cancelled",
                                          waitingFor: null,
                                          actions: [],
                                      },
                                  }
                                : current.steps,
                    };
                },
                async write(_projection, view) {
                    const response = await fetch(
                        withRecordingView(
                            `/api/recordings/${encodeURIComponent(itemId)}/intended-placements/${encodeURIComponent(folderId)}`,
                            view,
                        ),
                        { method: "DELETE" },
                    );
                    if (!response.ok) throw new Error(String(response.status));
                    return itemOperationResult(response);
                },
            });
            onChanged?.();
        } catch {
            toast.error(
                i18n(
                    "The intended Organization placement could not be cancelled.",
                ),
            );
        }
    };

    const shareNow = async () => {
        try {
            await enqueueOperation({
                pendingIntents: true,
                apply: (current) =>
                    current.intents.length === 0
                        ? current
                        : {
                              ...current,
                              intents: current.intents.map((intent) => ({
                                  ...intent,
                                  confirmationRequired: false,
                                  confirmed: true,
                              })),
                              steps: {
                                  ...current.steps,
                                  share: {
                                      state: "pending",
                                      reason: "confirmed",
                                      waitingFor: { kind: "pending" },
                                      actions: [],
                                  },
                              },
                          },
                async write(_projection, view) {
                    const response = await fetch(
                        withRecordingView(
                            `/api/recordings/${encodeURIComponent(itemId)}/intended-placements/confirm`,
                            view,
                        ),
                        { method: "POST" },
                    );
                    if (!response.ok) throw new Error(String(response.status));
                    return itemOperationResult(response);
                },
            });
            toast.success(i18n("Sharing started."));
            onChanged?.();
        } catch {
            toast.error(i18n("The item could not be shared."));
        }
    };

    const changeProfile = async (choice: string) => {
        if (!data || !panelData) return;
        const chosen = panelData.profiles.find(
            (profile) => profile.id === choice,
        );
        const manualOnly = choice === MANUAL_ONLY;
        try {
            await enqueueOperation({
                pendingProfile: true,
                apply: (current) => ({
                    ...current,
                    legacy: false,
                    manualOnly,
                    profile: previewProfile(current, chosen),
                }),
                async write(current, view) {
                    const folderIds = await profileFolderIds(itemId, current);
                    const response = await fetch(
                        withRecordingView(
                            `/api/recordings/${encodeURIComponent(itemId)}/categorize`,
                            view,
                        ),
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
                    return itemOperationResult(response);
                },
            });
            onChanged?.();
        } catch {
            toast.error(i18n("The profile could not be changed."));
        }
    };

    const processAgain = async () => {
        if (detail.pendingProcessAgain) return;
        try {
            await enqueueOperation(processAgainOperation(itemId));
            toast.success(i18n("Processing requested."));
            onChanged?.();
        } catch {
            toast.error(i18n("The item could not be processed again."));
        }
    };

    const submitCategorize = async (
        submission: CategorizeSubmission,
        write: (
            override?: CategorizeSubmission,
        ) => Promise<ItemOperationResult>,
    ) => {
        if (!panelData) return;
        const selected = submission.folderIds.flatMap((id) => {
            const summary = panelData.folders.find(
                (folder) => folder.id === id,
            );
            if (summary) return [summary];
            const folder = folders.find((folder) => folder.id === id);
            return folder ? [{ ...folder, path: folder.name }] : [];
        });
        const target = selected.find(
            (folder) => folder.id === submission.folderIds[0],
        );
        const personal = selected.filter(
            (folder) => folder.scope === "personal",
        );
        const org = selected.filter((folder) => folder.scope === "org");
        const chosen = panelData.profiles.find(
            (profile) => profile.id === submission.profileId,
        );
        const profileOnly = filingMode === "profile";
        const at = new Date().toISOString();
        const keptOrganizationFolder = (id: string) =>
            org.some((folder) => folder.id === id) ||
            folders.some(
                (folder) =>
                    folder.id === id &&
                    folder.scope === "org" &&
                    folder.parentId === null,
            );

        setPendingFilingMode(filingMode);
        try {
            await enqueueOperation({
                folders: profileOnly
                    ? undefined
                    : {
                          pendingIds: submission.folderIds,
                          addedIds: [
                              ...personal,
                              ...org.filter(
                                  (folder) =>
                                      folder.restricted || folder.restricting,
                              ),
                          ].map((folder) => folder.id),
                          apply: (ids) => [
                              ...new Set([
                                  ...ids.filter(keptOrganizationFolder),
                                  ...personal.map((folder) => folder.id),
                              ]),
                          ],
                      },
                pendingProfile: true,
                apply: (current) => {
                    const manualOnly =
                        submission.manualOnly ??
                        (submission.profileId ? false : current.manualOnly);
                    return {
                        ...current,
                        manualOnly,
                        placements: profileOnly
                            ? current.placements
                            : [
                                  ...current.placements.filter(
                                      (folder) =>
                                          folder.scope === "org" &&
                                          (folder.parentId === null ||
                                              keptOrganizationFolder(
                                                  folder.id,
                                              )),
                                  ),
                                  ...personal,
                              ],
                        intents: profileOnly
                            ? current.intents
                            : org
                                  .filter(
                                      (folder) =>
                                          !current.placements.some(
                                              (placement) =>
                                                  placement.id === folder.id,
                                          ),
                                  )
                                  .map((folder) => ({
                                      folderId: folder.id,
                                      name: folder.name,
                                      path: folder.path,
                                      confirmationRequired: manualOnly,
                                      confirmed: false,
                                  })),
                        profile: previewProfile(current, chosen),
                        steps: {
                            ...current.steps,
                            categorize: {
                                state: "done",
                                reason: "categorized",
                                waitingFor: null,
                                actions: [],
                            },
                        },
                        phases: {
                            ...current.phases,
                            categorize: {
                                state: "done",
                                reason: "categorized",
                                generation:
                                    current.phases.categorize?.generation ?? 0,
                                at,
                            },
                        },
                    };
                },
                async write(current) {
                    if (profileOnly) {
                        const folderIds = await profileFolderIds(
                            itemId,
                            current,
                        );
                        return write({ ...submission, folderIds });
                    }
                    if (
                        current &&
                        target?.scope === "org" &&
                        !target.restricted &&
                        !target.restricting
                    ) {
                        const retained = current.placements
                            .filter(
                                (folder) =>
                                    folder.scope === "org" && folder.restricted,
                            )
                            .map((folder) => folder.id);
                        return write({
                            ...submission,
                            folderIds: [target.id, ...retained],
                        });
                    }
                    return write();
                },
            });
        } finally {
            setPendingFilingMode(null);
        }
    };

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
            case "learn":
                onLearn?.();
                break;
            case "file":
            case "chooseProfile":
                loadPanel();
                focusFiling();
                break;
            case "reviewTrim": {
                const card = document.getElementById(
                    `recording-trim-${itemId}`,
                );
                card?.scrollIntoView({
                    block: "center",
                    behavior: workflowScrollBehavior(),
                });
                card?.focus();
                break;
            }
            case "reviewLearn":
                onReviewLearn?.();
                break;
            case "transcribe":
                onTranscribe?.(false);
                break;
            case "summarize":
                onSummary?.();
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
                else if (workflow?.status?.message === "failureInterrupted")
                    void processAgain();
                break;
            }
        }
    };

    const folderProps = {
        canCurate,
        onFolderCreated,
        folders,
        folderAssignments,
        onSelectFolder,
        onAddToFolder,
        onRemoveFromFolder,
        onMoveBetweenFolders,
    };

    const failedLearnRunId =
        canEdit &&
        workflow?.status?.action === "retry" &&
        workflow.status.params?.step === "learn"
            ? data?.failedLearnRunId
            : undefined;
    return (
        <>
            {processingEnabled && workflow && (
                <WorkflowStrip
                    workflow={workflow}
                    kind={kind}
                    onAction={handleAction}
                    secondaryAction={
                        failedLearnRunId ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={skippingLearn}
                                onClick={() => void skipLearn(failedLearnRunId)}
                            >
                                {i18n("Skip")}
                            </Button>
                        ) : undefined
                    }
                />
            )}
            {processingEnabled &&
                isOwn &&
                data?.steps.share?.reason === "gate_blocked" &&
                data.phases.share?.problems
                    ?.filter(isShareReviewProblem)
                    .map((problem) => {
                        const isLearn = problem.kind === "learn_unfinished";
                        const waitsForSummary =
                            !isLearn && problem.waiting === "summary";
                        return (
                            <p
                                key={problem.kind}
                                className="text-xs text-muted-foreground"
                            >
                                {shareProblemMessage(problem)}{" "}
                                <a
                                    className="font-medium text-primary underline underline-offset-2"
                                    href={shareReviewHref(itemId, problem)}
                                >
                                    {isLearn
                                        ? i18n("Open Learn")
                                        : waitsForSummary
                                          ? i18n("Open summary")
                                          : i18n("Review tasks")}
                                </a>
                            </p>
                        );
                    })}
            {stale && (
                <output className="flex items-center gap-1 text-xs text-muted-foreground">
                    {i18n("Status may be out of date")} ·{" "}
                    <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => void refresh()}
                    >
                        {i18n({ id: "processingRetry", message: "Try again" })}
                    </button>
                </output>
            )}
            {canEdit && filingMode && (
                <div ref={filingRef}>
                    {panelData?.itemId === itemId ? (
                        <CategorizePanel
                            data={panelData}
                            kind={kind}
                            mode={filingMode}
                            reason={profileReason}
                            onFolderCreated={onFolderCreated}
                            onTranscribe={() => onTranscribe?.(false)}
                            onSubmit={submitCategorize}
                            onStale={() => {
                                loadPanel(true);
                                invalidate();
                                onChanged?.();
                            }}
                            onCategorized={onChanged}
                        />
                    ) : (
                        <div className="flex min-h-24 items-center justify-center rounded-lg border text-sm text-muted-foreground">
                            <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
                            {i18n("Loading filing choices…")}
                        </div>
                    )}
                </div>
            )}
            {(!canEdit ||
                !filingMode ||
                (pendingFilingMode && detail.pendingFolderIds.size > 0)) && (
                <ProcessingFolderRow
                    itemId={itemId}
                    kind={kind}
                    processing={data}
                    panelData={panelData}
                    isOwn={isOwn}
                    canWithdraw={canWithdraw}
                    organizationOnly={view === "org"}
                    onLoadPanel={() => loadPanel()}
                    onProfileChange={(choice) => void changeProfile(choice)}
                    onCancelIntent={(folderId) => void cancelIntent(folderId)}
                    onShareNow={() => void shareNow()}
                    {...folderProps}
                />
            )}
        </>
    );
}
