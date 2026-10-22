"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useExtracted } from "next-intl";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppChrome } from "@/components/app-chrome-provider";
import { AppHeader } from "@/components/app-header";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { FirstLevelFolderDialog } from "@/components/dashboard/first-level-folder-dialog";
import { FolderSettingsPanel } from "@/components/dashboard/folder-settings-panel";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import { PlaudReconnectBanner } from "@/components/dashboard/plaud-reconnect-banner";
import {
    RecordingList,
    type RecordingListHandle,
} from "@/components/dashboard/recording-list";
import type { TranscriptOption } from "@/components/dashboard/transcription-panel";
import { TrialBanner } from "@/components/dashboard/trial-banner";
import {
    UploadDialog,
    uploadFolderOptions,
    uploadFolderParents,
} from "@/components/dashboard/upload-dialog";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { WorkstationEmptyState } from "@/components/dashboard/workstation-empty-state";
import { MailDetailPane } from "@/components/mail/mail-detail-pane";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import { Button } from "@/components/ui/button";
import { useFolderLabel } from "@/hooks/use-folder-label";
import {
    LibraryPreferencesContext,
    useLibraryPreferencesState,
} from "@/hooks/use-library-preferences";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useMailRefresh } from "@/hooks/use-mail-refresh";
import { useOrgEvents } from "@/hooks/use-org-events";
import { useShareRefusal } from "@/hooks/use-share-refusal";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import {
    type UploadCompletion,
    type UploadCompletionAction,
    useUploadQueue,
} from "@/hooks/use-upload-queue";
import { getApiErrorMessage, parseApiError } from "@/lib/api-errors";
import type { ExportProvidersAvailability } from "@/lib/folder-exports/types";
import {
    recordingIdsVisibleInFolder,
    sharedRecordingIds,
} from "@/lib/folders/hierarchy";
import {
    folderRowLocations,
    libraryNavigation,
} from "@/lib/folders/navigation";
import {
    applyFilenameOverrides,
    reconcileFilenameOverrides,
} from "@/lib/recordings/filename-overrides";
import type { ChatterSearchHit } from "@/lib/search/types";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { canChangeItem } from "@/lib/sharing/change-permission";
import { recordingJobSubject } from "@/lib/sharing/view";
import { cn } from "@/lib/utils";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    /** The text as people read it, when corrections change it. */
    readText?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    turns?: TranscriptOption["turns"];
    topics?: TranscriptOption["topics"];
}

const EMPTY_RECORDINGS: Recording[] = [];

function clearItemLinkContext(params: URLSearchParams) {
    for (const key of [...params.keys()]) {
        if (key === "playFrom" || key.startsWith("evidence"))
            params.delete(key);
    }
}

function dashboardLocation(params: URLSearchParams) {
    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

/** Shared recordings, read through their Organization view. */
export interface OrganizationLibrary {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    transcriptVariants: Map<string, TranscriptOption[]>;
}

interface WorkstationProps {
    userId?: string;
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    transcriptVariants?: Map<string, TranscriptOption[]>;
    initialSettings: InitialSettings;
    /**
     * True when Plaud has rejected the stored token (connection row carries
     * an `invalidatedAt`). Seeds the reconnect banner on first paint; the
     * live sync result takes over once a sync runs. Server-supplied.
     */
    plaudNeedsReconnect: boolean;
    isHosted: boolean;
    /** The instance receives mail and the viewer may have addresses. */
    mailEnabled?: boolean;
    exportProviders: ExportProvidersAvailability;
    initialFolderOrganization: FolderOrganization;
    /** Null when the Organization scope is not enabled. */
    organizationLibrary?: OrganizationLibrary | null;
    /** The organization account: no private library, only the Organization. */
    isOrgAccount?: boolean;
    /** The viewer changes the Organization's content (a curator). */
    canCurate?: boolean;
}

/** Recording library, selection, uploads and transcription actions. */
export function Workstation({
    userId,
    recordings,
    transcriptions,
    transcriptVariants,
    initialSettings,
    plaudNeedsReconnect,
    isHosted,
    mailEnabled = false,
    exportProviders,
    initialFolderOrganization,
    organizationLibrary = null,
    isOrgAccount = false,
    canCurate = false,
}: WorkstationProps) {
    const i18n = useExtracted();
    const folderLabel = useFolderLabel();
    const shareRefusal = useShareRefusal();
    const { refresh } = useRouter();
    // A stable empty list: a fresh `[]` per render would re-run every effect
    // that depends on it, and one of them resets optimistic renames.
    const orgRecordings = organizationLibrary?.recordings ?? EMPTY_RECORDINGS;
    // The organization account has no library of its own; its "recent" list
    // is the Organization's.
    const libraryRecordings = isOrgAccount ? orgRecordings : recordings;
    const locationQuery = useSearchParams().toString();
    const initialQuery = locationQuery;
    const newcomer =
        !isOrgAccount && recordings.length === 0 && orgRecordings.length > 0;
    const newest = (items: Recording[]) =>
        [...items].sort(
            (a, b) => Date.parse(b.startTime) - Date.parse(a.startTime),
        )[0] ?? null;
    const initialOrgRoot = initialFolderOrganization.folders.find(
        (folder) => folder.scope === "org" && folder.parentId === null,
    );
    const initialLocation =
        new URLSearchParams(initialQuery).get("folder") ??
        (!new URLSearchParams(initialQuery).has("recording") && newcomer
            ? initialOrgRoot?.id
            : null) ??
        "recent";
    const [currentRecording, setCurrentRecording] = useState<Recording | null>(
        () => newest(newcomer ? orgRecordings : libraryRecordings),
    );
    const [orgContentRevision, setOrgContentRevision] = useState(0);
    const {
        settingsOpen,
        setSettingsOpen,
        onboardingOpen,
        paletteOpen,
        setPaletteOpen,
        shortcutsOpen,
        setShortcutsOpen,
        theme,
        setTheme,
        isAutoSyncing,
        lastSyncResult,
        manualSync,
        handleReconnected,
    } = useAppChrome();
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const [filenameOverrides, setFilenameOverrides] = useState<
        Map<string, string>
    >(() => new Map());
    // On <lg viewports the list and detail panes can't coexist -- we
    // toggle between them instead of stacking. Desktop ignores this
    // state entirely (both panes render via the grid).
    const [mobileView, setMobileView] = useState<"list" | "detail">("list");
    const mobileViewRef = useRef(mobileView);
    mobileViewRef.current = mobileView;
    const locationRecordingsRef = useRef<Recording[]>([]);
    const [location, setLocation] = useState<string>(initialLocation);
    const selectedFolderId = location === "recent" ? null : location;
    const setSelectedFolderId = useCallback(
        (id: string | null) => setLocation(id ?? "recent"),
        [],
    );
    const [folderOrganization, setFolderOrganization] =
        useState<FolderOrganization>(initialFolderOrganization);
    const [settingsFolderId, setSettingsFolderId] = useState<string | null>(
        null,
    );
    const [exportReturn, setExportReturn] = useState<{
        folderId: string;
        view: "form" | "list";
    } | null>(null);
    const handleExportReopen = useCallback(() => setExportReturn(null), []);
    const [settingsAction, setSettingsAction] = useState<
        "create" | undefined
    >();
    const handleFolderCreated = useCallback((folder: CreatedFolder) => {
        setFolderOrganization((current) =>
            current.folders.some((item) => item.id === folder.id)
                ? current
                : { ...current, folders: [...current.folders, folder] },
        );
    }, []);
    const navigationFolders = useMemo(
        () =>
            folderOrganization.folders.filter(
                (folder) => !isOrgAccount || folder.scope === "org",
            ),
        [folderOrganization.folders, isOrgAccount],
    );
    const preferenceRecordings = useMemo(
        () =>
            (isOrgAccount ? orgRecordings : recordings).filter(
                (item) => !hiddenIds.has(item.id),
            ),
        [recordings, orgRecordings, isOrgAccount, hiddenIds],
    );
    const libraryPreferences = useLibraryPreferencesState(
        userId,
        navigationFolders,
        folderOrganization.assignments,
        preferenceRecordings,
    );
    const { rememberFolder } = libraryPreferences;
    const selectedFolderIdRef = useRef(selectedFolderId);
    selectedFolderIdRef.current = selectedFolderId;
    const [firstLevelFolderOpen, setFirstLevelFolderOpen] = useState(false);
    const [resetToRecentKey, setResetToRecentKey] = useState(0);
    const selectionRevisionRef = useRef(0);
    const uploadSelectionRevisionsRef = useRef(new Map<string, number>());
    const [pendingUploadSelection, setPendingUploadSelection] = useState<{
        recordingId: string;
        selectionRevision: number;
        historyMethod: "push" | "replace";
    } | null>(null);

    useMailRefresh(mailEnabled);
    const listRef = useRef<RecordingListHandle>(null);
    const handledLocationQuery = useRef<string | null>(null);
    const [itemLinkQuery, setItemLinkQuery] = useState("");
    const writeSelection = useCallback(
        (
            recording: Recording | null,
            folderId: string | null,
            method: "push" | "replace" = "replace",
            intendedMobileView = mobileViewRef.current,
        ) => {
            const params = new URLSearchParams(window.location.search);
            clearItemLinkContext(params);
            params.delete("recording");
            params.delete("folder");
            params.delete("view");
            params.delete("googleExport");
            if (folderId) {
                params.set("folder", folderId);
            }
            if (recording) {
                params.set("recording", recording.id);
                if (recording.view === "org") params.set("view", "org");
            }
            handledLocationQuery.current = params.toString();
            const sameUrl =
                params.toString() ===
                new URLSearchParams(window.location.search).toString();
            if (
                sameUrl &&
                window.history.state?.mobileView === intendedMobileView
            )
                return;
            window.history[method === "push" ? "pushState" : "replaceState"](
                { mobileView: intendedMobileView },
                "",
                dashboardLocation(params),
            );
        },
        [],
    );
    const selectRecording = useCallback(
        (recording: Recording, method: "push" | "replace") => {
            selectionRevisionRef.current += 1;
            setPendingUploadSelection(null);
            setItemLinkQuery("");
            setCurrentRecording(recording);
            setMobileView("detail");
            let folderId = selectedFolderIdRef.current;
            if (
                !locationRecordingsRef.current.some(
                    (item) =>
                        item.id === recording.id &&
                        item.view === recording.view,
                )
            ) {
                folderId =
                    recording.view === "org" && !isOrgAccount
                        ? (folderOrganization.folders.find(
                              (folder) =>
                                  folder.scope === "org" &&
                                  folderOrganization.assignments.some(
                                      (assignment) =>
                                          assignment.recordingId ===
                                              recording.id &&
                                          assignment.folderId === folder.id,
                                  ),
                          )?.id ??
                          folderOrganization.folders.find(
                              (folder) =>
                                  folder.scope === "org" &&
                                  folder.parentId === null,
                          )?.id ??
                          null)
                        : null;
                setSelectedFolderId(folderId);
            }
            writeSelection(recording, folderId, method, "detail");
        },
        [writeSelection, folderOrganization, isOrgAccount, setSelectedFolderId],
    );
    const selectRecordingByUser = useCallback(
        (recording: Recording) => {
            selectRecording(recording, "push");
        },
        [selectRecording],
    );
    const selectRecordingAutomatically = useCallback(
        (recording: Recording) => {
            selectRecording(recording, "replace");
        },
        [selectRecording],
    );
    const selectFolderByUser = useCallback(
        (folder: RecordingFolder) => {
            selectionRevisionRef.current += 1;
            setPendingUploadSelection(null);
            setItemLinkQuery("");
            setSelectedFolderId(folder.id);
            rememberFolder(folder.id);
            const pool =
                folder.scope === "org" ? orgRecordings : libraryRecordings;
            const ids = recordingIdsVisibleInFolder(
                folderOrganization.folders,
                folderOrganization.assignments,
                folder,
                pool.map((item) => item.id),
            );
            const kept =
                currentRecording &&
                ids.has(currentRecording.id) &&
                !hiddenIds.has(currentRecording.id)
                    ? pool.find((item) => item.id === currentRecording.id)
                    : null;
            const first =
                kept ??
                [...pool]
                    .filter(
                        (item) => ids.has(item.id) && !hiddenIds.has(item.id),
                    )
                    .sort(
                        (a, b) =>
                            Date.parse(b.startTime) - Date.parse(a.startTime),
                    )[0] ??
                null;
            setCurrentRecording(first);
            setMobileView("list");
            writeSelection(first, folder.id, "push", "list");
        },
        [
            currentRecording,
            folderOrganization,
            hiddenIds,
            libraryRecordings,
            orgRecordings,
            rememberFolder,
            setSelectedFolderId,
            writeSelection,
        ],
    );
    const openSearchHit = useCallback(
        (hit: ChatterSearchHit): boolean => {
            const organization =
                new URL(hit.href, window.location.origin).searchParams.get(
                    "view",
                ) === "org";
            const preferred = organization ? orgRecordings : recordings;
            const fallback = organization ? recordings : orgRecordings;
            const linked =
                preferred.find((item) => item.id === hit.id) ??
                fallback.find((item) => item.id === hit.id);
            if (!linked || hiddenIds.has(linked.id)) return false;
            selectRecordingByUser(linked);
            return true;
        },
        [orgRecordings, recordings, hiddenIds, selectRecordingByUser],
    );

    const readLocation = useCallback(
        (traversing = false) => {
            const params = new URLSearchParams(window.location.search);
            if (
                !traversing &&
                handledLocationQuery.current === params.toString()
            )
                return;
            const firstLoad = handledLocationQuery.current === null;
            const reopenExport = params.get("googleExport");
            if (reopenExport) {
                const [exportFolderId, view] = reopenExport.split(".");
                if (
                    navigationFolders.some(
                        (folder) => folder.id === exportFolderId,
                    )
                ) {
                    setExportReturn({
                        folderId: exportFolderId,
                        view: view === "list" ? "list" : "form",
                    });
                    setSettingsFolderId(exportFolderId);
                }
                params.delete("googleExport");
                window.history.replaceState(
                    { mobileView: window.history.state?.mobileView },
                    "",
                    dashboardLocation(params),
                );
            }

            if (traversing) clearItemLinkContext(params);
            handledLocationQuery.current = params.toString();
            if (traversing)
                window.history.replaceState(
                    { mobileView: window.history.state?.mobileView },
                    "",
                    dashboardLocation(params),
                );
            selectionRevisionRef.current += 1;
            setPendingUploadSelection(null);
            const recordingId = params.get("recording");
            const folderId = params.get("folder");
            const folder = navigationFolders.find(
                (folder) => folder.id === folderId,
            );
            const firstFolder =
                firstLoad && !recordingId && !folderId && newcomer
                    ? initialOrgRoot
                    : null;
            const locationFolder = folder ?? firstFolder;
            setSelectedFolderId(locationFolder?.id ?? null);
            if (locationFolder) rememberFolder(locationFolder.id);
            if (recordingId) {
                const preferred =
                    params.get("view") === "org" ||
                    isOrgAccount ||
                    locationFolder?.scope === "org"
                        ? orgRecordings
                        : recordings;
                const fallback =
                    preferred === orgRecordings ? recordings : orgRecordings;
                const linked = hiddenIds.has(recordingId)
                    ? undefined
                    : (preferred.find((item) => item.id === recordingId) ??
                      fallback.find((item) => item.id === recordingId));
                setCurrentRecording(linked ?? null);
                if (linked?.view === "org") params.set("view", "org");
                else params.delete("view");
                setItemLinkQuery(linked ? params.toString() : "");
                const restoredView = window.history.state?.mobileView;
                const nextMobileView =
                    restoredView === "list" || restoredView === "detail"
                        ? restoredView
                        : traversing && locationFolder
                          ? "list"
                          : "detail";
                setMobileView(nextMobileView);
                if (!linked)
                    toast.error(
                        i18n(
                            "This item is not available to you. It may belong to someone else, no longer be shared with your Organization, or have been deleted.",
                        ),
                    );
                writeSelection(
                    linked ?? null,
                    locationFolder?.id ?? null,
                    "replace",
                    nextMobileView,
                );
                return;
            }
            setItemLinkQuery("");
            const pool =
                locationFolder?.scope === "org"
                    ? orgRecordings
                    : libraryRecordings;
            const ids = locationFolder
                ? recordingIdsVisibleInFolder(
                      folderOrganization.folders,
                      folderOrganization.assignments,
                      locationFolder,
                      pool.map((item) => item.id),
                  )
                : null;
            const initial =
                firstLoad || locationFolder
                    ? ([...pool]
                          .filter(
                              (item) =>
                                  !hiddenIds.has(item.id) &&
                                  (!ids || ids.has(item.id)),
                          )
                          .sort(
                              (a, b) =>
                                  Date.parse(b.startTime) -
                                  Date.parse(a.startTime),
                          )[0] ?? null)
                    : null;
            setCurrentRecording(initial);
            setMobileView("list");
            writeSelection(
                initial,
                locationFolder?.id ?? null,
                "replace",
                "list",
            );
        },
        [
            folderOrganization,
            rememberFolder,
            navigationFolders,
            newcomer,
            initialOrgRoot,
            isOrgAccount,
            setSelectedFolderId,
            hiddenIds,
            i18n,
            libraryRecordings,
            orgRecordings,
            recordings,
            writeSelection,
        ],
    );

    useEffect(() => {
        if (
            locationQuery ===
            new URLSearchParams(window.location.search).toString()
        )
            readLocation();
    }, [locationQuery, readLocation]);

    useEffect(() => {
        const onPopState = () => readLocation(true);
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, [readLocation]);

    useEffect(() => {
        setFolderOrganization(initialFolderOrganization);
    }, [initialFolderOrganization]);

    // Filter out optimistically-hidden (deleted) rows.
    const visibleRecordings = useMemo(
        () =>
            applyFilenameOverrides(
                libraryRecordings.filter((r) => !hiddenIds.has(r.id)),
                filenameOverrides,
            ),
        [libraryRecordings, hiddenIds, filenameOverrides],
    );
    const visibleOrgRecordings = useMemo(
        () =>
            applyFilenameOverrides(
                orgRecordings.filter((r) => !hiddenIds.has(r.id)),
                filenameOverrides,
            ),
        [orgRecordings, hiddenIds, filenameOverrides],
    );
    // Everything the folder tree counts: own recordings for Private, shared
    // ones for the Organization tree.
    const treeRecordings = useMemo(
        () =>
            isOrgAccount
                ? visibleOrgRecordings
                : [...visibleRecordings, ...visibleOrgRecordings],
        [isOrgAccount, visibleOrgRecordings, visibleRecordings],
    );

    const currentIsOrgView = currentRecording?.view === "org";
    const currentTranscription = currentRecording
        ? (currentIsOrgView
              ? organizationLibrary?.transcriptions
              : transcriptions
          )?.get(currentRecording.id)
        : undefined;
    const currentTranscriptVariants = currentRecording
        ? (currentIsOrgView
              ? organizationLibrary?.transcriptVariants
              : transcriptVariants
          )?.get(currentRecording.id)
        : undefined;

    const selectedRecording = currentRecording
        ? ((currentIsOrgView ? visibleOrgRecordings : visibleRecordings).find(
              (r) => r.id === currentRecording.id,
          ) ?? currentRecording)
        : null;
    const selectedFolder = selectedFolderId
        ? (folderOrganization.folders.find(
              (folder) => folder.id === selectedFolderId,
          ) ?? null)
        : null;
    const locationRecordings = useMemo(() => {
        const pool =
            selectedFolder?.scope === "org"
                ? visibleOrgRecordings
                : visibleRecordings;
        if (!selectedFolder) return pool;
        const ids = recordingIdsVisibleInFolder(
            folderOrganization.folders,
            folderOrganization.assignments,
            selectedFolder,
            pool.map((item) => item.id),
        );
        return pool.filter((item) => ids.has(item.id));
    }, [
        folderOrganization,
        selectedFolder,
        visibleOrgRecordings,
        visibleRecordings,
    ]);
    locationRecordingsRef.current = locationRecordings;
    const rowLocations = useMemo(
        () =>
            folderRowLocations(
                folderOrganization.folders,
                folderOrganization.assignments,
                selectedFolder,
            ),
        [folderOrganization, selectedFolder],
    );
    const locationIsOrg = selectedFolder?.scope === "org" || isOrgAccount;
    const locationTranscriptions = locationIsOrg
        ? (organizationLibrary?.transcriptions ?? transcriptions)
        : transcriptions;
    // A shared recording is changed for the Organization, by its curators
    // (or the organization account), on the Organization view; read-only
    // there for anyone else, and in its owner's private copy.
    const sharedIds = useMemo(
        () => sharedRecordingIds(folderOrganization),
        [folderOrganization],
    );
    const selectedShared = selectedRecording
        ? sharedIds.has(selectedRecording.id)
        : false;
    const selectedTranscriptReadOnly = selectedRecording
        ? !canChangeItem({
              view: currentIsOrgView ? "org" : "private",
              isOwn: selectedRecording.isOwn !== false,
              isOrgAccount,
              canCurate,
          })
        : false;

    // Keep currentRecording in sync with the recordings prop (updated
    // after refresh()). If the previously-selected recording is no
    // longer present (e.g. just deleted), clear the selection.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (
            currentRecording &&
            params.get("recording") === currentRecording.id &&
            (params.get("view") === "org") === (currentRecording.view === "org")
        ) {
            const updated = (
                currentRecording.view === "org" ? orgRecordings : recordings
            ).find((recording) => recording.id === currentRecording.id);
            if (updated !== currentRecording) {
                setCurrentRecording(updated ?? null);
                if (!updated) writeSelection(null, selectedFolderId);
            }
        }
        // When server data comes back, clear any optimistic hides whose
        // rows no longer exist server-side (deletion confirmed).
        setHiddenIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            const ids = new Set(recordings.map((r) => r.id));
            for (const id of prev) {
                if (ids.has(id)) next.add(id); // still present -> keep hidden until confirmed
            }
            return next.size === prev.size ? prev : next;
        });
        setFilenameOverrides((prev) =>
            reconcileFilenameOverrides(
                isOrgAccount ? orgRecordings : recordings,
                prev,
            ),
        );
    }, [
        isOrgAccount,
        recordings,
        orgRecordings,
        currentRecording,
        selectedFolderId,
        writeSelection,
    ]);

    useEffect(() => {
        if (!pendingUploadSelection) return;
        if (
            pendingUploadSelection.selectionRevision !==
            selectionRevisionRef.current
        ) {
            setPendingUploadSelection(null);
            return;
        }
        const uploaded = recordings.find(
            (recording) => recording.id === pendingUploadSelection.recordingId,
        );
        if (!uploaded) return;
        selectRecording(uploaded, pendingUploadSelection.historyMethod);
        setPendingUploadSelection(null);
    }, [pendingUploadSelection, recordings, selectRecording]);

    const handleUploadStarted = useCallback(
        ({ uploadId }: { uploadId: string }) => {
            uploadSelectionRevisionsRef.current.set(
                uploadId,
                selectionRevisionRef.current,
            );
        },
        [],
    );

    const handleUploadComplete = useCallback(
        ({
            recordingId,
            uploadId,
            resumed,
        }: UploadCompletion): UploadCompletionAction | undefined => {
            const uploadSelection =
                uploadSelectionRevisionsRef.current.get(uploadId);
            uploadSelectionRevisionsRef.current.delete(uploadId);
            refresh();
            const selectUploadedRecording = (
                selectionRevision: number,
                historyMethod: "push" | "replace" = "replace",
            ) => {
                setSelectedFolderId(null);
                setResetToRecentKey((key) => key + 1);
                setPendingUploadSelection({
                    recordingId,
                    selectionRevision,
                    historyMethod,
                });
            };
            if (resumed) {
                return {
                    label: i18n("Open"),
                    onClick: () => {
                        selectUploadedRecording(
                            selectionRevisionRef.current,
                            "push",
                        );
                    },
                };
            }
            if (
                uploadSelection === undefined ||
                uploadSelection !== selectionRevisionRef.current
            ) {
                return;
            }
            selectUploadedRecording(uploadSelection);
        },
        [i18n, refresh, setSelectedFolderId],
    );

    const handleUploadFailed = useCallback((uploadId: string) => {
        uploadSelectionRevisionsRef.current.delete(uploadId);
    }, []);

    const handleSync = useCallback(async () => {
        await manualSync();
    }, [manualSync]);

    // Prefer the live sync result once we have one; fall back to the
    // server-rendered flag on first paint (before any sync runs). A
    // change in `plaudNeedsReconnect` only happens when fresh server
    // truth arrives (e.g. a `router.refresh()` after another tab's sync
    // invalidated the token), so it always resets the override rather
    // than letting a stale client-side result keep masking it.
    const [reconnectOverride, setReconnectOverride] = useState<boolean | null>(
        null,
    );
    const prevPlaudNeedsReconnect = useRef(plaudNeedsReconnect);
    useEffect(() => {
        if (plaudNeedsReconnect !== prevPlaudNeedsReconnect.current) {
            prevPlaudNeedsReconnect.current = plaudNeedsReconnect;
            setReconnectOverride(null);
        }
    }, [plaudNeedsReconnect]);
    useEffect(() => {
        if (typeof lastSyncResult?.needsReconnect === "boolean") {
            setReconnectOverride(lastSyncResult.needsReconnect);
        }
    }, [lastSyncResult]);
    const showReconnect = reconnectOverride ?? plaudNeedsReconnect;

    const {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        selectedFile,
        confirmUpload,
        cancelUpload,
        triggerUpload,
    } = useUploadQueue({
        onUploadStarted: handleUploadStarted,
        onUploadFailed: handleUploadFailed,
        onUploadComplete: handleUploadComplete,
    });
    const uploadFolders = useMemo(
        () =>
            uploadFolderOptions(
                navigationFolders,
                organizationLibrary !== null,
                folderLabel,
            ),
        [folderLabel, navigationFolders, organizationLibrary],
    );
    const uploadFolderParentOptions = useMemo(
        () => uploadFolderParents(navigationFolders, canCurate, folderLabel),
        [canCurate, folderLabel, navigationFolders],
    );
    const hasFilingFolder = uploadFolders.length > 0;

    const { inFlightActions, observeTranscriptionById, transcribeById } =
        useTranscribeQueue({ onTranscribeComplete: refresh });

    useEffect(() => {
        if (currentRecording && currentRecording.kind !== "mail") {
            void observeTranscriptionById(
                currentRecording.id,
                currentRecording.view,
            );
        }
    }, [currentRecording, observeTranscriptionById]);

    // Any transcribe in flight (across all recordings) blocks new
    // uploads. The previous `isTranscribing` boolean conflated "this
    // recording is being transcribed" with "some transcribe is
    // happening"; splitting them fixes a concurrency bug where two
    // pending transcribes would race each other's finally clauses.
    const anyTranscribing = Array.from(inFlightActions.values()).some(
        (kind) => kind === "transcribing",
    );
    const isCurrentTranscribing =
        currentRecording !== null &&
        inFlightActions.get(
            recordingJobSubject(
                currentRecording.id,
                currentRecording.view ?? "private",
            ),
        ) === "transcribing";
    const isProcessing = anyTranscribing || isUploading;
    // The organization account's library is the Organization view: its
    // transcripts, and its in-flight work keyed by the Organization subject.
    const libraryTranscriptions = isOrgAccount
        ? (organizationLibrary?.transcriptions ?? transcriptions)
        : transcriptions;
    const orgInFlightActions = useMemo(() => {
        const prefix = recordingJobSubject("", "org");
        return new Map(
            [...inFlightActions].flatMap(([key, kind]) =>
                key.startsWith(prefix)
                    ? [[key.slice(prefix.length), kind] as const]
                    : [],
            ),
        );
    }, [inFlightActions]);
    const libraryInFlightActions = isOrgAccount
        ? orgInFlightActions
        : inFlightActions;

    const handleTranscribe = useCallback(
        async (attributionSource?: string, retranscribe = false) => {
            if (!currentRecording) return;
            await transcribeById(
                currentRecording.id,
                attributionSource,
                currentRecording.view,
                retranscribe,
            );
        },
        [currentRecording, transcribeById],
    );

    // Other people's changes to the Organization arrive as invalidations.
    // Tree changes refresh the server data; a change to the recording on
    // screen also remounts its panels so they refetch the summary.
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentRecordingRef = useRef(currentRecording);
    currentRecordingRef.current = currentRecording;
    const libraryIdsRef = useRef(new Set<string>());
    libraryIdsRef.current = new Set(
        [...recordings, ...orgRecordings].map((recording) => recording.id),
    );
    useOrgEvents(organizationLibrary !== null, (event) => {
        if (event.type === "recording") {
            // Refetching the whole dashboard is not cheap; only for a
            // recording this viewer actually has in a list.
            if (!libraryIdsRef.current.has(event.recordingId)) return;
            if (
                currentRecordingRef.current?.view === "org" &&
                currentRecordingRef.current.id === event.recordingId
            ) {
                setOrgContentRevision((revision) => revision + 1);
            }
        }
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => refresh(), 300);
    });
    useEffect(
        () => () => {
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        },
        [],
    );

    const handleDelete = useCallback(
        async (recording: Recording) => {
            const id = recording.id;
            // Optimistic hide.
            setHiddenIds((prev) => new Set(prev).add(id));
            const wasCurrent = currentRecording?.id === id;
            if (wasCurrent) {
                const idx = locationRecordings.findIndex((r) => r.id === id);
                const next =
                    locationRecordings[idx + 1] ??
                    locationRecordings[idx - 1] ??
                    null;
                setItemLinkQuery("");
                setCurrentRecording(next);
                writeSelection(next, selectedFolderIdRef.current);
            }
            try {
                const res = await fetch(
                    recording.kind === "mail"
                        ? `/api/mail/${id}`
                        : `/api/recordings/${id}`,
                    {
                        method: "DELETE",
                    },
                );
                if (!res.ok) throw new Error(i18n("Delete failed"));
                if (posthog.__loaded) {
                    posthog.capture("recording_deleted");
                }
                if (recording.kind !== "mail") {
                    toast.success(i18n("Recording deleted"));
                }
                refresh();
            } catch (err) {
                // Rollback
                setHiddenIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
                if (wasCurrent) {
                    setCurrentRecording(recording);
                    writeSelection(recording, selectedFolderIdRef.current);
                }
                throw err;
            }
        },
        [currentRecording, locationRecordings, refresh, i18n, writeSelection],
    );

    const handleRenamed = useCallback(
        (filename: string) => {
            const id = currentRecording?.id;
            if (!id) return;
            setFilenameOverrides((prev) => new Map(prev).set(id, filename));
            refresh();
        },
        [currentRecording?.id, refresh],
    );

    const handleCreateFolder = useCallback(
        async (parentId: string, name: string) => {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not create folder"),
                    ),
                );
                throw new Error(i18n("Could not create folder"));
            }
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            handleFolderCreated(folder);
            toast.success(i18n("Folder created"));
        },
        [handleFolderCreated, i18n],
    );

    const handleRenameFolder = useCallback(
        async (folderId: string, name: string) => {
            const version = folderOrganization.folders.find(
                (folder) => folder.id === folderId,
            )?.version;
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, version }),
            });
            if (response.status === 409) {
                refresh();
                toast.error(
                    i18n("Someone else changed this folder. Try again."),
                );
                throw new Error(i18n("Could not rename folder"));
            }
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not rename folder"),
                    ),
                );
                throw new Error(i18n("Could not rename folder"));
            }
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            setFolderOrganization((current) => ({
                ...current,
                folders: current.folders.map((item) =>
                    item.id === folder.id ? folder : item,
                ),
            }));
            toast.success(i18n("Folder renamed"));
        },
        [folderOrganization.folders, i18n, refresh],
    );

    const handleMoveFolder = useCallback(
        async (
            folderId: string,
            parentId: string,
            beforeId?: string | null,
        ) => {
            const previous = folderOrganization;
            setFolderOrganization((current) => {
                const moved = current.folders.find(
                    (folder) => folder.id === folderId,
                );
                if (!moved) return current;
                const siblings = current.folders
                    .filter(
                        (folder) =>
                            folder.parentId === parentId &&
                            folder.id !== folderId,
                    )
                    .sort(
                        (left, right) =>
                            left.sortOrder - right.sortOrder ||
                            left.name.localeCompare(right.name),
                    );
                const beforeIndex =
                    beforeId == null
                        ? siblings.length
                        : siblings.findIndex(
                              (folder) => folder.id === beforeId,
                          );
                const insertionIndex =
                    beforeIndex < 0 ? siblings.length : beforeIndex;
                siblings.splice(insertionIndex, 0, {
                    ...moved,
                    parentId,
                });
                const orderById = new Map(
                    siblings.map((folder, index) => [folder.id, index * 1000]),
                );
                return {
                    ...current,
                    folders: current.folders.map((folder) => {
                        const sortOrder = orderById.get(folder.id);
                        return sortOrder === undefined
                            ? folder
                            : {
                                  ...folder,
                                  parentId:
                                      folder.id === folderId
                                          ? parentId
                                          : folder.parentId,
                                  sortOrder,
                              };
                    }),
                };
            });
            const version = previous.folders.find(
                (folder) => folder.id === folderId,
            )?.version;
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, beforeId, version }),
            });
            if (response.status === 409) {
                setFolderOrganization(previous);
                refresh();
                toast.error(
                    i18n("Someone else changed this folder. Try again."),
                );
                throw new Error(i18n("Could not move folder"));
            }
            if (!response.ok) {
                setFolderOrganization(previous);
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not move folder"),
                    ),
                );
                throw new Error(i18n("Could not move folder"));
            }
            setFolderOrganization((current) => ({
                ...current,
                folders: current.folders.map((folder) =>
                    folder.id === folderId
                        ? { ...folder, version: folder.version + 1 }
                        : folder,
                ),
            }));
            toast.success(i18n("Folder moved"));
        },
        [folderOrganization, i18n, refresh],
    );

    const handleDeleteFolder = useCallback(
        async (folderId: string) => {
            const deletedIds = new Set<string>([folderId]);
            let foundChild = true;
            while (foundChild) {
                foundChild = false;
                for (const folder of folderOrganization.folders) {
                    if (
                        folder.parentId &&
                        deletedIds.has(folder.parentId) &&
                        !deletedIds.has(folder.id)
                    ) {
                        deletedIds.add(folder.id);
                        foundChild = true;
                    }
                }
            }
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not delete folder"),
                    ),
                );
                throw new Error(i18n("Could not delete folder"));
            }
            const removeDeleted = (
                current: FolderOrganization,
            ): FolderOrganization => {
                const deletedFolder = current.folders.find(
                    (folder) => folder.id === folderId,
                );
                const orgRoot = current.folders.find(
                    (folder) =>
                        folder.scope === "org" && folder.parentId === null,
                );
                const remainingFolders = current.folders.filter(
                    (folder) => !deletedIds.has(folder.id),
                );
                const remainingAssignments = current.assignments.filter(
                    (assignment) => !deletedIds.has(assignment.folderId),
                );
                if (deletedFolder?.scope === "org" && orgRoot) {
                    const remainingOrgIds = new Set(
                        remainingFolders
                            .filter((folder) => folder.scope === "org")
                            .map((folder) => folder.id),
                    );
                    for (const assignment of current.assignments) {
                        if (
                            deletedIds.has(assignment.folderId) &&
                            !remainingAssignments.some(
                                (item) =>
                                    item.recordingId ===
                                        assignment.recordingId &&
                                    remainingOrgIds.has(item.folderId),
                            )
                        )
                            remainingAssignments.push({
                                recordingId: assignment.recordingId,
                                folderId: orgRoot.id,
                            });
                    }
                }
                return {
                    folders: remainingFolders,
                    assignments: remainingAssignments,
                };
            };
            setFolderOrganization(removeDeleted);
            const {
                folders: remainingFolders,
                assignments: remainingAssignments,
            } = removeDeleted(folderOrganization);
            const deletedFolder = folderOrganization.folders.find(
                (folder) => folder.id === folderId,
            );
            if (deletedFolder?.scope === "org") refresh();
            const currentFolderId = selectedFolderIdRef.current;
            if (currentFolderId && deletedIds.has(currentFolderId)) {
                const parent =
                    remainingFolders.find(
                        (folder) => folder.id === deletedFolder?.parentId,
                    ) ?? null;
                const pool =
                    parent?.scope === "org"
                        ? visibleOrgRecordings
                        : visibleRecordings;
                const ids = parent
                    ? recordingIdsVisibleInFolder(
                          remainingFolders,
                          remainingAssignments,
                          parent,
                          pool.map((item) => item.id),
                      )
                    : new Set(pool.map((item) => item.id));
                const next =
                    pool.find(
                        (item) =>
                            item.id === currentRecording?.id &&
                            ids.has(item.id),
                    ) ??
                    pool.find((item) => ids.has(item.id)) ??
                    null;
                setSelectedFolderId(parent?.id ?? null);
                setCurrentRecording(next);
                writeSelection(next, parent?.id ?? null);
            }
            toast.success(i18n("Folder deleted"));
        },
        [
            folderOrganization,
            currentRecording,
            visibleRecordings,
            visibleOrgRecordings,
            i18n,
            refresh,
            writeSelection,
            setSelectedFolderId,
        ],
    );

    const handleFolderAssignment = useCallback(
        async (
            recordingId: string,
            folderId: string,
            assigned: boolean,
            withdraw = false,
        ) => {
            const assignment = { recordingId, folderId };
            const previous = folderOrganization.assignments;
            setFolderOrganization((current) => ({
                ...current,
                assignments: assigned
                    ? current.assignments.some(
                          (item) =>
                              item.recordingId === recordingId &&
                              item.folderId === folderId,
                      )
                        ? current.assignments
                        : [...current.assignments, assignment]
                    : current.assignments.filter(
                          (item) =>
                              item.recordingId !== recordingId ||
                              item.folderId !== folderId,
                      ),
            }));
            const response = await fetch(
                `/api/recordings/${recordingId}/folders`,
                {
                    method: assigned ? "POST" : "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(
                        withdraw ? { folderId, withdraw } : { folderId },
                    ),
                },
            );
            if (!response.ok) {
                setFolderOrganization((current) => ({
                    ...current,
                    assignments: previous,
                }));
                const error = await parseApiError(response);
                // The last Organization folder after all: the caller asks
                // the owner to confirm the withdrawal.
                if (error.code === "WITHDRAW_UNCONFIRMED") {
                    throw Object.assign(new Error(error.error), {
                        code: error.code,
                    });
                }
                const refusal = shareRefusal(error);
                if (refusal) {
                    const recording = recordings.find(
                        (candidate) => candidate.id === recordingId,
                    );
                    toast.error(refusal, {
                        action: recording
                            ? {
                                  label: i18n("Open recording"),
                                  onClick: () => {
                                      selectRecordingByUser(recording);
                                      setSelectedFolderId(null);
                                      writeSelection(
                                          recording,
                                          null,
                                          "replace",
                                      );
                                  },
                              }
                            : undefined,
                    });
                } else {
                    toast.error(
                        error.error ||
                            (assigned
                                ? i18n("Could not add recording to folder")
                                : i18n(
                                      "Could not remove recording from folder",
                                  )),
                    );
                }
                throw new Error(i18n("Could not update folder assignment"));
            }
            if (assigned) rememberFolder(folderId);
            // Sharing or unsharing changes the Organization library itself.
            if (
                folderOrganization.folders.find(
                    (folder) => folder.id === folderId,
                )?.scope === "org"
            ) {
                refresh();
            }
        },
        [
            rememberFolder,
            setSelectedFolderId,
            folderOrganization.assignments,
            folderOrganization.folders,
            i18n,
            recordings,
            refresh,
            shareRefusal,
            selectRecordingByUser,
            writeSelection,
        ],
    );

    const handleMoveBetweenFolders = useCallback(
        async (
            recordingId: string,
            fromFolderId: string,
            toFolderId: string,
        ) => {
            const previous = folderOrganization.assignments;
            setFolderOrganization((current) => ({
                ...current,
                assignments: [
                    ...current.assignments.filter(
                        (item) =>
                            item.recordingId !== recordingId ||
                            item.folderId !== fromFolderId,
                    ),
                    { recordingId, folderId: toFolderId },
                ],
            }));
            const response = await fetch(
                `/api/recordings/${recordingId}/folders`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fromFolderId, toFolderId }),
                },
            );
            if (!response.ok) {
                setFolderOrganization((current) => ({
                    ...current,
                    assignments: previous,
                }));
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not move recording"),
                    ),
                );
                throw new Error(i18n("Could not move recording"));
            }
            rememberFolder(toFolderId);
            if (
                folderOrganization.folders.find(
                    (folder) => folder.id === toFolderId,
                )?.scope === "org"
            )
                refresh();
            toast.success(i18n("Recording moved"));
        },
        [
            folderOrganization.assignments,
            folderOrganization.folders,
            i18n,
            rememberFolder,
            refresh,
        ],
    );

    const settingsFolder = folderOrganization.folders.find(
        (folder) => folder.id === settingsFolderId,
    );
    const navigation = useMemo(
        () =>
            libraryNavigation(
                navigationFolders,
                folderOrganization.assignments,
                treeRecordings,
                folderLabel,
            ),
        [
            navigationFolders,
            folderOrganization.assignments,
            treeRecordings,
            folderLabel,
        ],
    );
    const openFolderSettings = (folder: RecordingFolder, action?: "create") => {
        setSettingsAction(action);
        setSettingsFolderId(folder.id);
    };

    // Keyboard shortcuts (global). Disabled while any modal is open
    // so the modal owns keyboard focus exclusively. The shortcuts
    // dialog itself uses these very keys to navigate its rows.
    useListKeyboardNav({
        onNext: () => listRef.current?.next(),
        onPrev: () => listRef.current?.prev(),
        onFocusSearch: () => listRef.current?.focusSearch(),
        onOpenPalette: () => setPaletteOpen(true),
        onOpenShortcuts: () => setShortcutsOpen(true),
        onOpenSettings: () => setSettingsOpen(true),
        globalShortcuts: false,
        enabled:
            !settingsOpen &&
            !onboardingOpen &&
            !paletteOpen &&
            !shortcutsOpen &&
            !settingsFolder &&
            !firstLevelFolderOpen,
    });

    const navigateRecent = () => {
        selectionRevisionRef.current += 1;
        setPendingUploadSelection(null);
        setItemLinkQuery("");
        setSelectedFolderId(null);
        const next =
            visibleRecordings.find(
                (item) => item.id === currentRecording?.id,
            ) ?? newest(visibleRecordings);
        setCurrentRecording(next);
        setMobileView("list");
        writeSelection(next, null, "push", "list");
    };
    const assignRecording = (id: string, folderId: string) =>
        handleFolderAssignment(id, folderId, true);
    const headerProps = {
        organization: { ...folderOrganization, folders: navigationFolders },
        recordings: treeRecordings,
        navigation,
        canCurate,
        folder: selectedFolder,
        onNavigate: (folder: RecordingFolder | null) =>
            folder ? selectFolderByUser(folder) : navigateRecent(),
        onSettings: (folder: RecordingFolder) => openFolderSettings(folder),
        onNewFolder: () =>
            selectedFolder && (selectedFolder.scope !== "org" || canCurate)
                ? openFolderSettings(selectedFolder, "create")
                : setFirstLevelFolderOpen(true),
        onAssign: assignRecording,
        onMove: handleMoveBetweenFolders,
    };
    const settingsCount = settingsFolder
        ? (navigation.counts.get(settingsFolder.id) ?? 0)
        : 0;
    const railCollapsed = libraryPreferences.preferences.collapsed;
    return (
        <LibraryPreferencesContext.Provider value={libraryPreferences}>
            <div className="bg-background">
                <div className="container mx-auto max-w-7xl px-4 py-6 xl:max-w-[100rem]">
                    <TrialBanner isHosted={isHosted} />
                    <AppHeader
                        upload={{
                            isUploading,
                            isProcessing,
                            inputRef: uploadInputRef,
                            onTrigger: triggerUpload,
                            onChange: handleUpload,
                        }}
                    />
                    <PlaudReconnectBanner
                        show={showReconnect}
                        onReconnected={handleReconnected}
                    />
                    <div
                        className={cn(
                            "grid grid-cols-1 items-start gap-4 lg:grid-cols-[350px_minmax(0,1fr)]",
                            !railCollapsed &&
                                "xl:grid-cols-[220px_330px_minmax(0,1fr)]",
                        )}
                    >
                        <div
                            className={cn(
                                "hidden xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)] xl:min-h-0",
                                !railCollapsed && "xl:block",
                            )}
                        >
                            <FolderTree
                                folders={navigationFolders}
                                assignments={folderOrganization.assignments}
                                recordings={treeRecordings}
                                selectedFolderId={selectedFolderId}
                                onRecent={navigateRecent}
                                onSelectFolder={selectFolderByUser}
                                onMoveFolder={handleMoveFolder}
                                onNewFolder={() =>
                                    setFirstLevelFolderOpen(true)
                                }
                                onAssignRecording={assignRecording}
                                onMoveRecording={handleMoveBetweenFolders}
                                canCurate={canCurate}
                                navigation={navigation}
                                recentCount={visibleRecordings.length}
                                onSettings={(folder) =>
                                    openFolderSettings(folder)
                                }
                                onCollapse={() =>
                                    libraryPreferences.setPreferences(
                                        (value) => ({
                                            ...value,
                                            collapsed: true,
                                        }),
                                    )
                                }
                            />
                        </div>
                        <div
                            className={cn(
                                "min-h-0 min-w-0 lg:h-[calc(100dvh-7rem)] lg:sticky lg:top-20 lg:block",
                                mobileView === "detail" && "hidden",
                            )}
                        >
                            <RecordingList
                                ref={listRef}
                                searchView={locationIsOrg ? "org" : "private"}
                                isOrgAccount={isOrgAccount}
                                recordings={locationRecordings}
                                mailEnabled={mailEnabled}
                                transcriptions={locationTranscriptions}
                                currentRecording={currentRecording}
                                pendingUploads={pendingUploads}
                                inFlightActions={
                                    locationIsOrg
                                        ? orgInFlightActions
                                        : inFlightActions
                                }
                                sharedItemIds={sharedIds}
                                onSelect={selectRecordingByUser}
                                onDelete={handleDelete}
                                initialDateTimeFormat={
                                    initialSettings.dateTimeFormat
                                }
                                initialSortOrder={
                                    initialSettings.recordingListSortOrder
                                }
                                initialKindFilter={
                                    initialSettings.chatterKindFilter
                                }
                                initialChunkSize={initialSettings.itemsPerPage}
                                resetToRecentKey={resetToRecentKey}
                                locationKey={location}
                                folder={selectedFolder}
                                folders={folderOrganization.folders}
                                rowLocations={rowLocations}
                                assignments={folderOrganization.assignments}
                                onAssignRecording={assignRecording}
                                onMoveRecording={handleMoveBetweenFolders}
                                canCurate={canCurate}
                                onFolderCreated={handleFolderCreated}
                                onFolderSettings={
                                    selectedFolder
                                        ? () =>
                                              openFolderSettings(selectedFolder)
                                        : undefined
                                }
                                header={
                                    <>
                                        <div
                                            className={
                                                railCollapsed
                                                    ? "hidden"
                                                    : "hidden xl:block"
                                            }
                                        >
                                            <LibraryLocationHeader
                                                {...headerProps}
                                                variant="rail"
                                                part="header"
                                            />
                                        </div>
                                        <div
                                            className={
                                                railCollapsed
                                                    ? "block"
                                                    : "xl:hidden"
                                            }
                                        >
                                            <LibraryLocationHeader
                                                {...headerProps}
                                                variant="walk"
                                                part="header"
                                                onShowRail={
                                                    railCollapsed
                                                        ? () =>
                                                              libraryPreferences.setPreferences(
                                                                  (value) => ({
                                                                      ...value,
                                                                      collapsed: false,
                                                                  }),
                                                              )
                                                        : undefined
                                                }
                                            />
                                        </div>
                                    </>
                                }
                                navigationContent={
                                    <>
                                        <div
                                            className={
                                                railCollapsed
                                                    ? "hidden"
                                                    : "hidden xl:block"
                                            }
                                        >
                                            <LibraryLocationHeader
                                                {...headerProps}
                                                variant="rail"
                                                part="tiles"
                                            />
                                        </div>
                                        <div
                                            className={
                                                railCollapsed
                                                    ? "block"
                                                    : "xl:hidden"
                                            }
                                        >
                                            <LibraryLocationHeader
                                                {...headerProps}
                                                variant="walk"
                                                part="tiles"
                                                onShowRail={
                                                    railCollapsed
                                                        ? () =>
                                                              libraryPreferences.setPreferences(
                                                                  (value) => ({
                                                                      ...value,
                                                                      collapsed: false,
                                                                  }),
                                                              )
                                                        : undefined
                                                }
                                            />
                                        </div>
                                        {newcomer &&
                                            selectedFolder?.scope === "org" && (
                                                <div className="m-3 rounded-lg border border-organization/30 bg-organization/10 p-3 text-xs">
                                                    <p>
                                                        {i18n(
                                                            "You have no items of your own yet, so you start in the Organization. Your items will appear in Recent.",
                                                        )}
                                                    </p>
                                                    <div className="mt-2 flex gap-2">
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={
                                                                isAutoSyncing
                                                            }
                                                            onClick={handleSync}
                                                        >
                                                            {i18n(
                                                                "Sync Device",
                                                            )}
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={
                                                                triggerUpload
                                                            }
                                                        >
                                                            {i18n("Upload")}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                    </>
                                }
                                emptyState={
                                    visibleRecordings.length === 0 &&
                                    visibleOrgRecordings.length === 0 &&
                                    pendingUploads.length === 0 ? (
                                        <div className="mt-4 lg:hidden">
                                            <WorkstationEmptyState
                                                compact
                                                isSyncing={isAutoSyncing}
                                                onSync={handleSync}
                                                onUpload={triggerUpload}
                                                hasFilingFolder={
                                                    hasFilingFolder
                                                }
                                                onNewFolder={() =>
                                                    setFirstLevelFolderOpen(
                                                        true,
                                                    )
                                                }
                                            />
                                        </div>
                                    ) : undefined
                                }
                            />
                        </div>
                        {visibleRecordings.length === 0 &&
                        visibleOrgRecordings.length === 0 &&
                        pendingUploads.length === 0 ? (
                            <div className="hidden min-w-0 lg:block lg:self-start">
                                <WorkstationEmptyState
                                    isSyncing={isAutoSyncing}
                                    onSync={handleSync}
                                    onUpload={triggerUpload}
                                    hasFilingFolder={hasFilingFolder}
                                    onNewFolder={() =>
                                        setFirstLevelFolderOpen(true)
                                    }
                                />
                            </div>
                        ) : selectedRecording?.kind === "mail" ? (
                            <MailDetailPane
                                mail={selectedRecording}
                                itemLinkQuery={itemLinkQuery}
                                shared={selectedShared}
                                dateTimeFormat={initialSettings.dateTimeFormat}
                                backLabel={
                                    selectedFolder
                                        ? folderLabel(selectedFolder)
                                        : i18n("Recent")
                                }
                                onBackToList={() => {
                                    setMobileView("list");
                                    writeSelection(
                                        selectedRecording,
                                        selectedFolderId,
                                        "replace",
                                        "list",
                                    );
                                }}
                                hiddenOnMobile={mobileView === "list"}
                                onChanged={refresh}
                                onFolderCreated={handleFolderCreated}
                                folders={folderOrganization.folders}
                                folderAssignments={
                                    folderOrganization.assignments
                                }
                                onSelectFolder={selectFolderByUser}
                                onAddToFolder={(itemId, folderId) =>
                                    handleFolderAssignment(
                                        itemId,
                                        folderId,
                                        true,
                                    )
                                }
                                onRemoveFromFolder={(
                                    itemId,
                                    folderId,
                                    withdraw,
                                ) =>
                                    handleFolderAssignment(
                                        itemId,
                                        folderId,
                                        false,
                                        withdraw,
                                    )
                                }
                                onMoveBetweenFolders={handleMoveBetweenFolders}
                                isOrgAccount={isOrgAccount}
                                canCurate={canCurate}
                            />
                        ) : (
                            <WorkstationDetailPane
                                currentRecording={selectedRecording}
                                canCurate={canCurate}
                                itemLinkQuery={itemLinkQuery}
                                currentTranscription={currentTranscription}
                                transcripts={currentTranscriptVariants}
                                isCurrentTranscribing={isCurrentTranscribing}
                                visibleRecordings={locationRecordings}
                                onTranscribe={handleTranscribe}
                                onTranscribeComplete={refresh}
                                onTranscriptStale={refresh}
                                onFolderCreated={handleFolderCreated}
                                transcriptReadOnly={selectedTranscriptReadOnly}
                                recordingShared={selectedShared}
                                onSelectRecording={selectRecordingAutomatically}
                                onRenamed={handleRenamed}
                                onDelete={handleDelete}
                                onArtifactsChanged={refresh}
                                backLabel={
                                    selectedFolder
                                        ? folderLabel(selectedFolder)
                                        : i18n("Recent")
                                }
                                onBackToList={() => {
                                    setMobileView("list");
                                    writeSelection(
                                        selectedRecording,
                                        selectedFolderId,
                                        "replace",
                                        "list",
                                    );
                                }}
                                hiddenOnMobile={mobileView === "list"}
                                initialPlaybackSpeed={
                                    initialSettings.defaultPlaybackSpeed
                                }
                                initialVolume={initialSettings.defaultVolume}
                                initialAutoPlayNext={
                                    initialSettings.autoPlayNext
                                }
                                scrubberStyle={initialSettings.playerScrubber}
                                folders={folderOrganization.folders}
                                folderAssignments={
                                    folderOrganization.assignments
                                }
                                onSelectFolder={selectFolderByUser}
                                onAddToFolder={(recordingId, folderId) =>
                                    handleFolderAssignment(
                                        recordingId,
                                        folderId,
                                        true,
                                    )
                                }
                                onRemoveFromFolder={(
                                    recordingId,
                                    folderId,
                                    withdraw,
                                ) =>
                                    handleFolderAssignment(
                                        recordingId,
                                        folderId,
                                        false,
                                        withdraw,
                                    )
                                }
                                onMoveBetweenFolders={handleMoveBetweenFolders}
                                contentRevision={orgContentRevision}
                            />
                        )}
                    </div>
                </div>
            </div>

            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                folders={navigationFolders}
                folderEntries={navigation.entries}
                onSelectFolder={selectFolderByUser}
                recordings={visibleRecordings}
                transcriptions={libraryTranscriptions}
                currentRecording={currentRecording}
                inFlightActions={libraryInFlightActions}
                currentTheme={theme}
                dateTimeFormat={initialSettings.dateTimeFormat}
                onSelectRecording={selectRecordingByUser}
                onOpenSearchHit={openSearchHit}
                onSync={handleSync}
                onUpload={triggerUpload}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onSetTheme={setTheme}
                onTranscribeRecording={(id) => {
                    // The organization account's library is the
                    // Organization view; everyone else's is private.
                    const recording = visibleRecordings.find(
                        (candidate) => candidate.id === id,
                    );
                    if (recording?.kind === "mail") return;
                    void transcribeById(id, undefined, recording?.view);
                }}
            />

            <UploadDialog
                file={selectedFile}
                folders={uploadFolders}
                folderParents={uploadFolderParentOptions}
                onFolderCreated={handleFolderCreated}
                open={selectedFile !== null}
                onOpenChange={(open) => {
                    if (!open) cancelUpload();
                }}
                onUpload={(folderId) => void confirmUpload(folderId)}
                selectedFolderId={selectedFolderId}
            />

            <FirstLevelFolderDialog
                folders={navigationFolders}
                includeOrganization={canCurate}
                open={firstLevelFolderOpen}
                onOpenChange={setFirstLevelFolderOpen}
                onCreated={handleFolderCreated}
            />
            {settingsFolder && (
                <FolderSettingsPanel
                    key={settingsFolder.id}
                    folder={settingsFolder}
                    folders={folderOrganization.folders}
                    count={settingsCount}
                    open
                    onOpenChange={(open) => {
                        if (!open) setSettingsFolderId(null);
                    }}
                    onRename={handleRenameFolder}
                    onCreate={handleCreateFolder}
                    onMove={handleMoveFolder}
                    onDelete={handleDeleteFolder}
                    exportProviders={exportProviders}
                    mailEnabled={mailEnabled}
                    canCurate={canCurate}
                    isOrgAccount={isOrgAccount}
                    initialAction={settingsAction}
                    onReopenHandled={handleExportReopen}
                    reopenExport={
                        exportReturn?.folderId === settingsFolder.id
                            ? exportReturn.view
                            : undefined
                    }
                />
            )}
        </LibraryPreferencesContext.Provider>
    );
}
