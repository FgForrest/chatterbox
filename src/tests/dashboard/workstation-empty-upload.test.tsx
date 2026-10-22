// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { type ComponentProps, type Ref, useImperativeHandle } from "react";
import type { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArrivalNotice } from "@/components/dashboard/arrival-notice";
import type { CommandPalette as CommandPaletteComponent } from "@/components/dashboard/command-palette";
import type { FolderSettingsPanel as FolderSettingsPanelComponent } from "@/components/dashboard/folder-settings-panel";
import type { RecordingListHandle } from "@/components/dashboard/recording-list";
import type { Workstation as WorkstationComponent } from "@/components/dashboard/workstation";
import type { UploadCompletionAction } from "@/hooks/use-upload-queue";
import type { Recording } from "@/types/recording";

const mocks = vi.hoisted(() => ({
    inFlightActions: new Map<string, "transcribing" | "summarizing">(),
    refresh: vi.fn(),
    error: vi.fn(),
    custom: vi.fn<typeof toast.custom>(() => "new-item"),
    dismiss: vi.fn<typeof toast.dismiss>(() => "new-item"),
    settingsProps: null as ComponentProps<
        typeof FolderSettingsPanelComponent
    > | null,
    paletteProps: null as ComponentProps<typeof CommandPaletteComponent> | null,
    uploadOptions: null as null | {
        onUploadStarted?: (upload: {
            uploadId: string;
            filename: string;
        }) => void;
        onUploadFailed?: (uploadId: string) => void;
        onUploadComplete: (upload: {
            recordingId: string;
            uploadId: string;
            filename: string;
            resumed: boolean;
        }) => UploadCompletionAction | undefined;
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mocks.refresh }),
    useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("next-intl", () => ({
    useExtracted:
        () => (text: string, values?: Record<string, string | number>) =>
            text.replace(/\{(\w+)\}/g, (match, key: string) =>
                String(values?.[key] ?? match),
            ),
    useLocale: () => "en",
}));

vi.mock("sonner", () => ({
    toast: {
        error: mocks.error,
        success: vi.fn(),
        custom: mocks.custom,
        dismiss: mocks.dismiss,
    },
}));

vi.mock("posthog-js", () => ({ default: { __loaded: false } }));

vi.mock("@/components/app-chrome-provider", () => ({
    useAppChrome: () => ({
        settingsOpen: false,
        setSettingsOpen: vi.fn(),
        onboardingOpen: false,
        paletteOpen: false,
        setPaletteOpen: vi.fn(),
        shortcutsOpen: false,
        setShortcutsOpen: vi.fn(),
        theme: "light",
        setTheme: vi.fn(),
        isAutoSyncing: false,
        lastSyncResult: null,
        manualSync: vi.fn(),
        handleReconnected: vi.fn(),
    }),
}));

vi.mock("@/hooks/use-auto-sync", () => ({
    useAutoSync: () => ({
        isAutoSyncing: false,
        lastSyncTime: null,
        nextSyncTime: null,
        lastSyncResult: null,
        manualSync: vi.fn(),
    }),
}));

vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnectOutcome: vi.fn(),
}));

vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: vi.fn() }));
vi.mock("@/hooks/use-share-refusal", () => ({
    useShareRefusal: () => vi.fn(),
}));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({
        inFlightActions: mocks.inFlightActions,
        observeTranscriptionById: vi.fn(),
        transcribeById: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: (options: typeof mocks.uploadOptions) => {
        mocks.uploadOptions = options;
        return {
            isUploading: false,
            pendingUploads: [],
            uploadInputRef: { current: null },
            handleUpload: vi.fn(),
            selectedFile: null,
            confirmUpload: vi.fn(),
            cancelUpload: vi.fn(),
            triggerUpload: vi.fn(),
        };
    },
}));

vi.mock("@/components/app-header", () => ({
    AppHeader: () => <div>Dashboard header</div>,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: ({
        ref,
        recordings,
        currentRecording,
        onSelect,
        onDelete,
        header,
        navigationContent,
        locationKey,
        inFlightActions,
        emptyState,
    }: {
        ref?: Ref<RecordingListHandle>;
        recordings: Recording[];
        currentRecording: Recording | null;
        onSelect: (recording: Recording) => void;
        onDelete: (recording: Recording) => Promise<void>;
        header?: React.ReactNode;
        navigationContent?: React.ReactNode;
        locationKey: string;
        inFlightActions: Map<string, "transcribing" | "summarizing">;
        emptyState?: React.ReactNode;
    }) => {
        useImperativeHandle(ref, () => ({
            next: () =>
                onSelect(
                    recordings[
                        Math.min(
                            recordings.length - 1,
                            recordings.findIndex(
                                (item) => item.id === currentRecording?.id,
                            ) + 1,
                        )
                    ],
                ),
            prev: () =>
                onSelect(
                    recordings[
                        Math.max(
                            0,
                            recordings.findIndex(
                                (item) => item.id === currentRecording?.id,
                            ) - 1,
                        )
                    ],
                ),
            focusSearch: vi.fn(),
        }));
        return (
            <section aria-label="Recent recordings">
                <span data-testid="location">{locationKey}</span>
                <span data-testid="list-actions">
                    {JSON.stringify([...inFlightActions])}
                </span>
                {header}
                {navigationContent}
                {recordings.map((recording) => (
                    <div key={recording.id}>
                        <button
                            type="button"
                            key={recording.id}
                            aria-pressed={currentRecording?.id === recording.id}
                            onClick={() => onSelect(recording)}
                        >
                            {recording.filename}
                        </button>
                        <button
                            type="button"
                            onClick={() => void onDelete(recording)}
                        >
                            Delete {recording.filename}
                        </button>
                    </div>
                ))}
                {recordings.length === 0 ? (
                    <>
                        <p>No recordings yet.</p>
                        {emptyState}
                    </>
                ) : null}
            </section>
        );
    },
}));
vi.mock("@/components/dashboard/folder-settings-panel", () => ({
    FolderSettingsPanel: (
        props: ComponentProps<typeof FolderSettingsPanelComponent>,
    ) => {
        mocks.settingsProps = props;
        return <div>Folder settings</div>;
    },
}));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: ({
        onNewFolder,
        onSelectFolder,
        onRecent,
        onSettings,
    }: {
        onSettings: (folder: typeof personalChildFolder) => void;
        onNewFolder?: () => void;
        onSelectFolder: (folder: typeof personalChildFolder) => void;
        onRecent: () => void;
    }) => (
        <section aria-label="Folder tree">
            <button type="button" onClick={onNewFolder}>
                New folder
            </button>
            <button
                type="button"
                onClick={() => onSelectFolder(personalChildFolder)}
            >
                Open folder
            </button>
            <button type="button" onClick={onRecent}>
                Recent
            </button>
            <button
                type="button"
                onClick={() => onSettings(personalChildFolder)}
            >
                Folder settings
            </button>
        </section>
    ),
}));
vi.mock("@/components/dashboard/library-location-header", () => ({
    LibraryLocationHeader: () => null,
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: ({
        currentRecording,
        itemLinkQuery,
        onSelectRecording,
        onDelete,
        onBackToList,
    }: {
        currentRecording: Recording | null;
        itemLinkQuery: string;
        onSelectRecording: (recording: Recording) => void;
        onDelete: (recording: Recording) => Promise<void>;
        onBackToList: () => void;
    }) => (
        <div>
            Selected: {currentRecording?.filename ?? "none"}
            <span data-testid="item-link-query">{itemLinkQuery}</span>
            <button
                type="button"
                onClick={() =>
                    onSelectRecording(recording("second", "Second recording"))
                }
            >
                Auto advance
            </button>
            <button
                type="button"
                onClick={() =>
                    currentRecording && void onDelete(currentRecording)
                }
            >
                Delete selected
            </button>
            <button type="button" onClick={onBackToList}>
                Back to list
            </button>
        </div>
    ),
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: (props: ComponentProps<typeof CommandPaletteComponent>) => {
        mocks.paletteProps = props;
        return null;
    },
}));
vi.mock("@/components/dashboard/shortcuts-dialog", () => ({
    ShortcutsDialog: () => null,
}));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: () => <div>Mail details</div>,
}));
vi.mock("@/components/settings-dialog", () => ({ SettingsDialog: () => null }));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: () => null,
}));

import { Workstation } from "@/components/dashboard/workstation";

const rootFolder = {
    id: "private-root",
    parentId: null,
    name: "Private",
    kind: "private" as const,
    sortOrder: 0,
    scope: "personal" as const,
    version: 1,
};

const personalChildFolder = {
    ...rootFolder,
    id: "personal-child",
    parentId: rootFolder.id,
    name: "Meetings",
    kind: "custom" as const,
};

const settings = {
    dateTimeFormat: "relative" as const,
    recordingListSortOrder: "oldest" as const,
    chatterKindFilter: "all" as const,
    itemsPerPage: 50,
    listDensity: "comfortable" as const,
    theme: "light" as const,
    defaultPlaybackSpeed: 1,
    defaultVolume: 75,
    autoPlayNext: false,
    playerScrubber: "waveform" as const,
    syncInterval: 300_000,
    autoSyncEnabled: false,
    syncOnMount: false,
    syncOnVisibilityChange: false,
    syncNotifications: false,
    browserNotifications: false,
    onboardingCompleted: true,
};

const baseProps: ComponentProps<typeof WorkstationComponent> = {
    recordings: [],
    transcriptions: new Map(),
    initialSettings: settings,
    plaudNeedsReconnect: false,
    isHosted: false,
    exportProviders: { filesystem: false, googleDrive: false, mail: false },
    initialFolderOrganization: {
        folders: [rootFolder],
        assignments: [],
    },
};

function recording(id: string, filename: string): Recording {
    return {
        id,
        filename,
        duration: 1_000,
        startTime: "2026-10-16T10:00:00.000Z",
        filesize: 1_000,
        deviceSn: "uploaded",
    };
}

afterEach(cleanup);

function arrivalCard() {
    const call = mocks.custom.mock.calls.at(-1);
    if (!call) throw new Error("Expected an arrival notice");
    expect(call[1]).toMatchObject({ id: "new-item", duration: Infinity });
    return call[0]("new-item") as ReactElement<
        ComponentProps<typeof ArrivalNotice>
    >;
}

describe("Dashboard arrival notices", () => {
    const first = recording("first", "First recording");
    const arrived = {
        ...recording("arrived", "Orbit notes"),
        duration: 65_000,
        startTime: "2026-10-22T10:00:00Z",
    };
    const later = {
        ...recording("later", "Meadow notes"),
        startTime: "2026-10-22T11:00:00Z",
    };
    const props = {
        ...baseProps,
        recordings: [first],
        initialSettings: { ...settings, dateTimeFormat: "iso" as const },
    };

    it("does not announce items present at mount", () => {
        render(<Workstation {...props} />);
        expect(mocks.custom).not.toHaveBeenCalled();
    });

    it("shows a recording's title and row metadata without changing selection, folder or URL", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=private-root&recording=first",
        );
        const { rerender } = render(<Workstation {...props} />);
        const url = window.location.href;
        const push = vi.spyOn(window.history, "pushState");
        const replace = vi.spyOn(window.history, "replaceState");
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        expect(window.location.href).toBe(url);
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        const card = render(arrivalCard());
        expect(card.getByText("New recording")).toBeTruthy();
        expect(card.getByTitle(arrived.filename)).toBeTruthy();
        expect(card.getByText("1:05 · 2026-10-22T10:00:00.000Z")).toBeTruthy();
        expect(
            card.getByRole("button", { name: 'Open "Orbit notes"' }),
        ).toBeTruthy();
        push.mockRestore();
        replace.mockRestore();
    });

    it("chooses the newest of a batch and accumulates later arrivals in one slot", () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(
            <Workstation {...props} recordings={[arrived, later, first]} />,
        );
        expect(arrivalCard().props).toMatchObject({
            recording: later,
            more: 1,
        });
        const third = { ...arrived, id: "third" };
        rerender(
            <Workstation
                {...props}
                recordings={[third, arrived, later, first]}
            />,
        );
        expect(arrivalCard().props).toMatchObject({
            recording: third,
            more: 2,
        });
        const card = render(arrivalCard());
        expect(card.getByText("+2 more")).toBeTruthy();
        expect(
            mocks.custom.mock.calls.every((call) => call[1]?.id === "new-item"),
        ).toBe(true);
    });

    it("Open pushes history, switches the phone to detail, closes, and Back returns", async () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        const push = vi.spyOn(window.history, "pushState");
        const card = render(arrivalCard());
        mocks.dismiss.mockClear();
        fireEvent.click(
            card.getByRole("button", { name: 'Open "Orbit notes"' }),
        );
        expect(screen.getByText("Selected: Orbit notes")).toBeTruthy();
        expect(push).toHaveBeenCalledTimes(1);
        expect(window.history.state.mobileView).toBe("detail");
        expect(mocks.dismiss).toHaveBeenCalledWith("new-item");
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        push.mockRestore();
    });

    it("opens an arrival outside the current folder through normal row selection", () => {
        const folderProps = {
            ...props,
            initialFolderOrganization: {
                folders: [rootFolder, personalChildFolder],
                assignments: [
                    { recordingId: first.id, folderId: personalChildFolder.id },
                ],
            },
        };
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=personal-child&recording=first",
        );
        const { rerender } = render(<Workstation {...folderProps} />);
        rerender(
            <Workstation {...folderProps} recordings={[arrived, first]} />,
        );
        expect(screen.getByTestId("location").textContent).toBe(
            "personal-child",
        );
        act(() => arrivalCard().props.onOpen());
        expect(screen.getByTestId("location").textContent).toBe("recent");
        expect(window.location.search).toBe("?recording=arrived");
    });

    it("close preserves selection and resets the count without announcing seen ids again", () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(
            <Workstation {...props} recordings={[arrived, later, first]} />,
        );
        const card = render(arrivalCard());
        fireEvent.click(card.getByRole("button", { name: "Close notice" }));
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        const count = mocks.custom.mock.calls.length;
        rerender(
            <Workstation {...props} recordings={[arrived, later, first]} />,
        );
        expect(mocks.custom).toHaveBeenCalledTimes(count);
        const third = { ...arrived, id: "third" };
        rerender(
            <Workstation
                {...props}
                recordings={[third, arrived, later, first]}
            />,
        );
        expect(arrivalCard().props.more).toBe(0);
    });

    it.each([
        "row",
        "keyboard",
        "palette",
        "search",
    ])("closes when the arrival is opened via %s", (source) => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[first, arrived]} />);
        mocks.dismiss.mockClear();
        if (source === "row")
            fireEvent.click(
                screen.getByRole("button", { name: arrived.filename }),
            );
        else if (source === "keyboard") fireEvent.keyDown(window, { key: "j" });
        else
            act(() => {
                if (source === "palette")
                    mocks.paletteProps?.onSelectRecording?.(arrived);
                else
                    mocks.paletteProps?.onOpenSearchHit?.({
                        id: arrived.id,
                        title: arrived.filename,
                        snippet: null,
                        href: "/dashboard?recording=arrived",
                    });
            });
        expect(mocks.dismiss).toHaveBeenCalledWith("new-item");
    });

    it("closes for a removed item and never reannounces it if it returns", () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        const count = mocks.custom.mock.calls.length;
        mocks.dismiss.mockClear();
        rerender(<Workstation {...props} />);
        expect(mocks.dismiss).toHaveBeenCalledWith("new-item");
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        expect(mocks.custom).toHaveBeenCalledTimes(count);
    });

    it("closes for an optimistically hidden item", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ ok: true })),
        );
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        mocks.dismiss.mockClear();
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", {
                    name: `Delete ${arrived.filename}`,
                }),
            ),
        );
        expect(mocks.dismiss).toHaveBeenCalledWith("new-item");
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        vi.unstubAllGlobals();
    });

    it("updates a title in place without counting another arrival", () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        const renamed = { ...arrived, filename: "Revised orbit notes" };
        rerender(<Workstation {...props} recordings={[renamed, first]} />);
        expect(arrivalCard().props).toMatchObject({
            recording: renamed,
            more: 0,
        });
        const card = render(arrivalCard());
        expect(
            card.getByRole("button", { name: 'Open "Revised orbit notes"' }),
        ).toBeTruthy();
    });

    it.each([
        false,
        true,
    ])("ignores colleagues' Organization shares: organization account=%s", (isOrgAccount) => {
        const own = { ...first, view: "org" as const, isOwn: true };
        const orgProps = {
            ...props,
            isOrgAccount,
            organizationLibrary: {
                recordings: [own],
                transcriptions: new Map(),
                transcriptVariants: new Map(),
            },
        };
        const { rerender } = render(<Workstation {...orgProps} />);
        const url = window.location.href;
        rerender(
            <Workstation
                {...orgProps}
                organizationLibrary={{
                    ...orgProps.organizationLibrary,
                    recordings: [
                        own,
                        { ...arrived, view: "org", isOwn: false },
                    ],
                }}
            />,
        );
        expect(mocks.custom).not.toHaveBeenCalled();
        expect(window.location.href).toBe(url);
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
    });

    it("announces the Organization account's own new items", () => {
        const own = { ...first, view: "org" as const, isOwn: true };
        const orgProps = {
            ...props,
            recordings: [],
            isOrgAccount: true,
            organizationLibrary: {
                recordings: [own],
                transcriptions: new Map(),
                transcriptVariants: new Map(),
            },
        };
        const { rerender } = render(<Workstation {...orgProps} />);
        rerender(
            <Workstation
                {...orgProps}
                organizationLibrary={{
                    ...orgProps.organizationLibrary,
                    recordings: [own, { ...arrived, view: "org", isOwn: true }],
                }}
            />,
        );
        expect(arrivalCard().props.recording.id).toBe(arrived.id);
    });

    it("shows mail's subject, sender and time without moving selection", () => {
        const mail = {
            ...arrived,
            kind: "mail" as const,
            mail: {
                from: "Zorven",
                senderVerified: true,
                hasAttachments: false,
                waitingToShare: false,
                autoGenerated: false,
            },
        };
        const { rerender } = render(<Workstation {...props} />);
        const url = window.location.href;
        rerender(<Workstation {...props} recordings={[mail, first]} />);
        expect(window.location.href).toBe(url);
        const card = render(arrivalCard());
        expect(card.getByText("New email")).toBeTruthy();
        expect(
            card.getByText("Zorven · 2026-10-22T10:00:00.000Z"),
        ).toBeTruthy();
    });

    it.each([
        "automatic",
        "moved",
        "resumed",
    ])("handles an own upload: %s", (mode) => {
        const second = recording("second", "Second recording");
        const { rerender } = render(
            <Workstation {...props} recordings={[first, second]} />,
        );
        if (mode === "automatic") expect(mocks.custom).not.toHaveBeenCalled();
        act(() =>
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "upload",
                filename: arrived.filename,
            }),
        );
        if (mode === "automatic") expect(mocks.custom).not.toHaveBeenCalled();
        if (mode === "moved")
            fireEvent.click(
                screen.getByRole("button", { name: second.filename }),
            );
        let action: UploadCompletionAction | undefined;
        act(() => {
            action = mocks.uploadOptions?.onUploadComplete({
                uploadId: "upload",
                recordingId: arrived.id,
                filename: arrived.filename,
                resumed: mode === "resumed",
            });
        });
        if (mode === "automatic") expect(mocks.custom).not.toHaveBeenCalled();
        rerender(
            <Workstation {...props} recordings={[arrived, first, second]} />,
        );
        if (mode === "moved") {
            expect(arrivalCard().props.recording.id).toBe(arrived.id);
            expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        } else {
            expect(mocks.custom).not.toHaveBeenCalled();
            expect(
                screen.getByText(
                    `Selected: ${mode === "automatic" ? arrived.filename : first.filename}`,
                ),
            ).toBeTruthy();
        }
        if (mode === "resumed") expect(action?.label).toBe("Open");
        if (mode === "automatic") {
            rerender(
                <Workstation
                    {...props}
                    recordings={[arrived, first, second]}
                />,
            );
            expect(mocks.custom).not.toHaveBeenCalled();
            fireEvent.click(
                screen.getByRole("button", { name: first.filename }),
            );
            expect(screen.getByText("Selected: First recording")).toBeTruthy();
            expect(mocks.custom).not.toHaveBeenCalled();
        }
    });

    it("never announces the currently selected arrival", () => {
        const { rerender } = render(<Workstation {...props} />);
        window.history.replaceState({}, "", "/dashboard?recording=arrived");
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        expect(mocks.custom).not.toHaveBeenCalled();
    });

    it("dismisses the slot when the dashboard unmounts", () => {
        const { rerender, unmount } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[arrived, first]} />);
        mocks.dismiss.mockClear();
        unmount();
        expect(mocks.dismiss).toHaveBeenCalledWith("new-item");
    });
});

beforeEach(() => {
    mocks.inFlightActions = new Map();
    mocks.refresh.mockClear();
    mocks.error.mockClear();
    mocks.custom.mockClear();
    mocks.dismiss.mockClear();
    mocks.uploadOptions = null;
    mocks.paletteProps = null;
    mocks.settingsProps = null;
    window.history.replaceState({}, "", "/dashboard");
});

describe("Workstation empty account", () => {
    it("keeps the recent list and makes first-level folder creation reachable", () => {
        render(<Workstation {...baseProps} />);

        expect(
            screen.getByRole("region", { name: "Recent recordings" }),
        ).toBeTruthy();
        expect(screen.getByText("No recordings yet.")).toBeTruthy();
        expect(
            screen.getAllByText(
                "Create a folder first. Then sync your device or upload a recording.",
            ).length,
        ).toBeGreaterThan(0);

        const folderTree = screen.getByRole("region", { name: "Folder tree" });
        fireEvent.click(
            within(folderTree).getByRole("button", { name: "New folder" }),
        );

        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByLabelText("Folder name")).toBeTruthy();
    });

    it("shows the no-recordings actions when a filing folder already exists", () => {
        render(
            <Workstation
                {...baseProps}
                initialFolderOrganization={{
                    folders: [rootFolder, personalChildFolder],
                    assignments: [],
                }}
            />,
        );

        expect(screen.queryByText("Start with a folder")).toBeNull();
        expect(
            screen.getAllByText("No recordings yet.").length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByRole("button", { name: "Sync Device" }).length,
        ).toBe(2);
        expect(screen.getAllByRole("button", { name: "Upload" }).length).toBe(
            2,
        );
    });

    it("does not show empty-account guidance for a mail-only account", () => {
        const mail: Recording = {
            ...recording("mail-1", "Project update"),
            kind: "mail",
            mail: {
                from: "sender@example.com",
                senderVerified: true,
                hasAttachments: false,
                waitingToShare: false,
                autoGenerated: false,
            },
        };

        render(<Workstation {...baseProps} recordings={[mail]} />);

        expect(screen.getByText("Mail details")).toBeTruthy();
        expect(screen.queryByText("Start with a folder")).toBeNull();
    });

    it("opens Organization content for a newcomer", () => {
        const shared = {
            ...recording("shared-1", "Shared recording"),
            view: "org" as const,
            isOwn: false,
        };

        render(
            <Workstation
                {...baseProps}
                initialFolderOrganization={{
                    folders: [
                        rootFolder,
                        {
                            ...rootFolder,
                            id: "org-root",
                            name: "Organization",
                            kind: "public",
                            scope: "org",
                        },
                    ],
                    assignments: [
                        { recordingId: shared.id, folderId: "org-root" },
                    ],
                }}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );

        expect(screen.getByText("Selected: Shared recording")).toBeTruthy();
        expect(screen.getByTestId("location").textContent).toBe("org-root");
        expect(window.location.search).toBe(
            "?folder=org-root&recording=shared-1&view=org",
        );
        expect(
            screen.getByText(/You have no items of your own yet/),
        ).toBeTruthy();
        expect(screen.queryByText("Start with a folder")).toBeNull();
    });

    it("selects a search result when the dashboard query changes", () => {
        window.history.replaceState({}, "", "/dashboard");
        const first = recording("first", "First recording");
        const second = recording("second", "Search result");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first, second]} />,
        );
        window.history.replaceState({}, "", "/dashboard?recording=second");
        rerender(<Workstation {...baseProps} recordings={[first, second]} />);
        expect(screen.getByText("Selected: Search result")).toBeTruthy();
        window.history.replaceState({}, "", "/dashboard");
    });

    it("selects the newest personal recording on first load", () => {
        const newest = {
            ...recording("newest", "Newest personal recording"),
            startTime: "2026-10-16T11:00:00.000Z",
        };
        const older = {
            ...recording("older", "Older personal recording"),
            startTime: "2026-10-16T10:00:00.000Z",
        };

        render(<Workstation {...baseProps} recordings={[newest, older]} />);

        expect(
            screen.getByText("Selected: Newest personal recording"),
        ).toBeTruthy();
    });
});

describe("Workstation upload completion", () => {
    it("selects the uploaded recording and returns to recent when selection was untouched", () => {
        const first = recording("first", "First recording");
        const uploaded = recording("uploaded", "Uploaded recording");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first]} />,
        );

        act(() =>
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "upload-1",
                filename: "Uploaded recording",
            }),
        );
        let action: UploadCompletionAction | undefined;
        act(() => {
            action = mocks.uploadOptions?.onUploadComplete({
                recordingId: "uploaded",
                uploadId: "upload-1",
                filename: "Uploaded recording",
                resumed: false,
            });
        });
        rerender(<Workstation {...baseProps} recordings={[uploaded, first]} />);

        expect(
            screen.getByRole("region", { name: "Recent recordings" }),
        ).toBeTruthy();
        expect(screen.getByText("Selected: Uploaded recording")).toBeTruthy();
        expect(mocks.refresh).toHaveBeenCalledTimes(1);
        expect(action).toBeUndefined();
    });

    it("leaves the current view and selection alone for a resumed conversion until Open is used", () => {
        const first = recording("first", "First recording");
        const uploaded = recording("uploaded", "Resumed recording");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first]} />,
        );

        act(() =>
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "conversion:resumed",
                filename: "Resumed recording",
            }),
        );
        let action: UploadCompletionAction | undefined;
        act(() => {
            action = mocks.uploadOptions?.onUploadComplete({
                recordingId: "uploaded",
                uploadId: "conversion:resumed",
                filename: "Resumed recording",
                resumed: true,
            });
        });
        rerender(<Workstation {...baseProps} recordings={[uploaded, first]} />);

        expect(
            screen.getByRole("region", { name: "Folder tree" }),
        ).toBeTruthy();
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(action?.label).toBe("Open");

        act(() => action?.onClick());

        expect(
            screen.getByRole("region", { name: "Recent recordings" }),
        ).toBeTruthy();
        expect(screen.getByText("Selected: Resumed recording")).toBeTruthy();
    });

    it("does not steal selection after the person selects another recording", () => {
        const first = recording("first", "First recording");
        const second = recording("second", "Second recording");
        const uploaded = recording("uploaded", "Uploaded recording");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first, second]} />,
        );

        act(() =>
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "upload-1",
                filename: "Uploaded recording",
            }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Second recording" }),
        );
        act(() =>
            mocks.uploadOptions?.onUploadComplete({
                recordingId: "uploaded",
                uploadId: "upload-1",
                filename: "Uploaded recording",
                resumed: false,
            }),
        );
        rerender(
            <Workstation
                {...baseProps}
                recordings={[uploaded, first, second]}
            />,
        );

        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
    });

    it("selects the last concurrent upload to finish", () => {
        const first = recording("first", "First recording");
        const uploadOne = recording("upload-one", "Upload one");
        const uploadTwo = recording("upload-two", "Upload two");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first]} />,
        );

        act(() => {
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "pending-one",
                filename: "Upload one",
            });
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "pending-two",
                filename: "Upload two",
            });
            mocks.uploadOptions?.onUploadComplete({
                recordingId: "upload-one",
                uploadId: "pending-one",
                filename: "Upload one",
                resumed: false,
            });
            mocks.uploadOptions?.onUploadComplete({
                recordingId: "upload-two",
                uploadId: "pending-two",
                filename: "Upload two",
                resumed: false,
            });
        });
        rerender(
            <Workstation
                {...baseProps}
                recordings={[uploadTwo, uploadOne, first]}
            />,
        );

        expect(screen.getByText("Selected: Upload two")).toBeTruthy();
    });

    it("clears failed upload selection tracking", () => {
        const first = recording("first", "First recording");
        const uploaded = recording("uploaded", "Uploaded recording");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first]} />,
        );

        act(() => {
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "upload-1",
                filename: "Uploaded recording",
            });
            mocks.uploadOptions?.onUploadFailed?.("upload-1");
            mocks.uploadOptions?.onUploadComplete({
                recordingId: "uploaded",
                uploadId: "upload-1",
                filename: "Uploaded recording",
                resumed: false,
            });
        });
        rerender(<Workstation {...baseProps} recordings={[uploaded, first]} />);

        expect(screen.getByText("Selected: First recording")).toBeTruthy();
    });
});

describe("Workstation search selection", () => {
    it("opens loaded Organization hits and items beyond the palette cap without refreshing", () => {
        const recordings = Array.from({ length: 201 }, (_, index) =>
            recording(`item-${index}`, `Recording ${index}`),
        );
        const shared = {
            ...recording("shared", "Shared result"),
            view: "org" as const,
            isOwn: false,
        };
        render(
            <Workstation
                {...baseProps}
                recordings={recordings}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );
        let handled = false;
        act(() => {
            handled =
                mocks.paletteProps?.onOpenSearchHit?.({
                    id: "item-200",
                    title: "Recording 200",
                    snippet: null,
                    href: "/dashboard?recording=item-200",
                }) ?? false;
        });
        expect(handled).toBe(true);
        expect(screen.getByText("Selected: Recording 200")).toBeTruthy();
        act(() => {
            handled =
                mocks.paletteProps?.onOpenSearchHit?.({
                    id: "shared",
                    title: "Shared result",
                    snippet: null,
                    href: "/dashboard?recording=shared&view=org",
                }) ?? false;
        });
        expect(handled).toBe(true);
        expect(screen.getByText("Selected: Shared result")).toBeTruthy();
        expect(mocks.refresh).not.toHaveBeenCalled();
        expect(mocks.paletteProps?.currentRecording?.view).toBe("org");
        expect(
            mocks.paletteProps?.onOpenSearchHit?.({
                id: "missing",
                title: "Missing",
                snippet: null,
                href: "/dashboard?recording=missing",
            }),
        ).toBe(false);
    });
    it("reopens the same search link after a list selection", () => {
        const first = recording("first", "First recording");
        const second = recording("second", "Second recording");
        window.history.replaceState({}, "", "/dashboard?recording=first");
        render(<Workstation {...baseProps} recordings={[first, second]} />);
        const hit = {
            id: first.id,
            title: first.filename,
            snippet: null,
            href: "/dashboard?recording=first",
        };
        act(() => {
            mocks.paletteProps?.onOpenSearchHit?.(hit);
        });
        fireEvent.click(screen.getByRole("button", { name: second.filename }));
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        act(() => {
            mocks.paletteProps?.onOpenSearchHit?.(hit);
        });
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(window.location.search).toBe("?recording=first");
    });
    it("preserves a URL selection when an earlier upload completes", () => {
        const first = recording("first", "First recording");
        const linked = recording("linked", "Linked recording");
        const uploaded = recording("uploaded", "Uploaded recording");
        const { rerender } = render(
            <Workstation {...baseProps} recordings={[first, linked]} />,
        );
        act(() =>
            mocks.uploadOptions?.onUploadStarted?.({
                uploadId: "upload",
                filename: uploaded.filename,
            }),
        );
        window.history.replaceState({}, "", "/dashboard?recording=linked");
        rerender(<Workstation {...baseProps} recordings={[first, linked]} />);
        act(() => {
            mocks.uploadOptions?.onUploadComplete({
                recordingId: uploaded.id,
                uploadId: "upload",
                filename: uploaded.filename,
                resumed: false,
            });
        });
        rerender(
            <Workstation
                {...baseProps}
                recordings={[uploaded, first, linked]}
            />,
        );
        expect(screen.getByText("Selected: Linked recording")).toBeTruthy();
    });
    it("keeps j/k list navigation on the dashboard", () => {
        render(
            <Workstation
                {...baseProps}
                recordings={[
                    recording("first", "First"),
                    recording("second", "Second"),
                ]}
            />,
        );
        fireEvent.keyDown(window, { key: "j" });
        expect(screen.getByText("Selected: Second")).toBeTruthy();
        fireEvent.keyDown(window, { key: "k" });
        expect(screen.getByText("Selected: First")).toBeTruthy();
    });
});

describe("Workstation selection history", () => {
    const first = recording("first", "First recording");
    const second = recording("second", "Second recording");
    const shared = {
        ...recording("shared", "Shared recording"),
        view: "org" as const,
        isOwn: false,
    };
    const props = {
        ...baseProps,
        recordings: [first, second],
        organizationLibrary: {
            recordings: [shared],
            transcriptions: new Map(),
            transcriptVariants: new Map(),
        },
        initialFolderOrganization: {
            folders: [rootFolder, personalChildFolder],
            assignments: [],
        },
    };

    it("replaces the first-load entry and pushes a person's selection without server navigation", () => {
        const push = vi.spyOn(window.history, "pushState");
        const replace = vi.spyOn(window.history, "replaceState");
        render(<Workstation {...props} />);
        expect(window.location.search).toBe("?recording=first");
        expect(replace).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: second.filename }));
        expect(window.location.search).toBe("?recording=second");
        expect(push).toHaveBeenCalledTimes(1);
        expect(mocks.refresh).not.toHaveBeenCalled();
        push.mockRestore();
        replace.mockRestore();
    });

    it("drops playback and every evidence parameter while keeping unrelated query parameters and the hash", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=first&playFrom=165980&evidenceSegment=0&evidenceStart=4&evidenceEnd=9&evidenceExtra=1&search=meeting#section",
        );
        render(<Workstation {...props} />);
        expect(window.location.search).not.toContain("playFrom");
        expect(screen.getByTestId("item-link-query").textContent).toContain(
            "playFrom=165980",
        );
        fireEvent.click(screen.getByRole("button", { name: second.filename }));
        expect(window.location.search).toBe("?search=meeting&recording=second");
        expect(window.location.hash).toBe("#section");
    });

    it("restores selections on Back and Forward without replaying the linked position", async () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=first&playFrom=165980&evidenceStart=4",
        );
        render(<Workstation {...props} />);
        fireEvent.click(screen.getByRole("button", { name: second.filename }));
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(window.location.search).toBe("?recording=first");
        expect(screen.getByTestId("item-link-query").textContent).not.toContain(
            "playFrom",
        );
        await act(async () => {
            window.history.forward();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
    });

    it("replaces the URL on auto advance and keeps selection when returning to the mobile list", () => {
        render(<Workstation {...props} />);
        const push = vi.spyOn(window.history, "pushState");
        fireEvent.click(screen.getByRole("button", { name: "Auto advance" }));
        expect(window.location.search).toBe("?recording=second");
        fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
        expect(window.location.search).toBe("?recording=second");
        expect(push).not.toHaveBeenCalled();
        push.mockRestore();
    });

    it("replaces the URL after deletion", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("{}")),
        );
        render(<Workstation {...props} />);
        const push = vi.spyOn(window.history, "pushState");
        fireEvent.click(
            screen.getByRole("button", { name: "Delete selected" }),
        );
        await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
        expect(window.location.search).toBe("?recording=second");
        expect(push).not.toHaveBeenCalled();
        push.mockRestore();
        vi.unstubAllGlobals();
    });

    it("drops a deep link's context when Recent or a delete re-selects an item", async () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=first&playFrom=165980&evidenceStart=4",
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("{}")),
        );
        render(<Workstation {...props} />);
        expect(screen.getByTestId("item-link-query").textContent).toContain(
            "playFrom=165980",
        );
        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(screen.getByTestId("item-link-query").textContent).toBe("");

        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=first&evidenceStart=4",
        );
        act(() => {
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Delete selected" }),
        );
        await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(screen.getByTestId("item-link-query").textContent).toBe("");
        vi.unstubAllGlobals();
    });

    it("pushes a folder and restores it with Back", async () => {
        render(<Workstation {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        expect(window.location.search).toBe("?folder=personal-child");
        expect(screen.getByTestId("location").textContent).toBe(
            "personal-child",
        );
        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(window.location.search).toBe("?recording=first");
        expect(screen.getByTestId("item-link-query").textContent).not.toContain(
            "playFrom",
        );
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByTestId("location").textContent).toBe(
            "personal-child",
        );
    });

    it.each([
        "?recording=missing",
        "?recording=missing&view=org",
    ])("explains unavailable links: %s", (query) => {
        window.history.replaceState({}, "", `/dashboard${query}`);
        render(<Workstation {...props} />);
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
            "This item is not available to you. It may belong to someone else, no longer be shared with your Organization, or have been deleted.",
        );
        expect(screen.getByText("Selected: none")).toBeTruthy();
        expect(window.location.search).toBe("");
    });

    it.each([
        "",
        "&view=org",
    ])("opens Organization-only links with or without their view: %s", (view) => {
        window.history.replaceState(
            {},
            "",
            `/dashboard?recording=shared${view}`,
        );
        render(<Workstation {...props} />);
        expect(screen.getByText("Selected: Shared recording")).toBeTruthy();
        expect(window.location.search).toBe("?recording=shared&view=org");
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it("normalizes captured evidence context when falling back to Organization", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=shared&playFrom=12500",
        );
        render(<Workstation {...props} />);
        const context = new URLSearchParams(
            screen.getByTestId("item-link-query").textContent ?? "",
        );
        expect(context.get("view")).toBe("org");
        expect(context.get("playFrom")).toBe("12500");
        expect(window.location.search).toBe("?recording=shared&view=org");
    });

    it("pushes Organization selections from the search palette", () => {
        render(<Workstation {...props} />);
        const push = vi.spyOn(window.history, "pushState");
        act(() => {
            mocks.paletteProps?.onOpenSearchHit?.({
                id: "shared",
                title: "Shared",
                snippet: null,
                href: "/dashboard?recording=shared&view=org",
            });
        });
        expect(window.location.search).toBe("?recording=shared&view=org");
        expect(push).toHaveBeenCalledTimes(1);
        push.mockRestore();
    });

    it("opens mail through the same item parameter", () => {
        const mail = {
            ...first,
            id: "mail-1",
            kind: "mail" as const,
            filename: "Mail item",
        };
        render(<Workstation {...props} recordings={[first, mail]} />);
        fireEvent.click(screen.getByRole("button", { name: "Mail item" }));
        expect(window.location.search).toBe("?recording=mail-1");
        expect(screen.getByText("Mail details")).toBeTruthy();
    });

    it("falls back to Private for a stale Organization view", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?recording=second&view=org",
        );
        render(<Workstation {...props} />);
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(window.location.search).toBe("?recording=second");
    });

    it("opens a link outside the rendered list window", () => {
        const recordings = Array.from({ length: 201 }, (_, index) =>
            recording(`item-${index}`, `Recording ${index}`),
        );
        window.history.replaceState({}, "", "/dashboard?recording=item-200");
        render(<Workstation {...props} recordings={recordings} />);
        expect(screen.getByText("Selected: Recording 200")).toBeTruthy();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it("clears selection for a plain dashboard history entry", () => {
        render(<Workstation {...props} />);
        act(() => {
            window.history.replaceState({}, "", "/dashboard");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(screen.getByText("Selected: none")).toBeTruthy();
        expect(window.location.search).toBe("");
    });

    it("clears the URL when refreshed data no longer contains the selected item", () => {
        const { rerender } = render(<Workstation {...props} />);
        rerender(<Workstation {...props} recordings={[second]} />);
        expect(screen.getByText("Selected: none")).toBeTruthy();
        expect(window.location.search).toBe("");
    });
});

describe("Workstation folder locations", () => {
    const first = recording("first", "First recording");
    const second = recording("second", "Second recording");
    const organization = {
        ...rootFolder,
        id: "org-root",
        kind: "public" as const,
        scope: "org" as const,
        name: "Organization",
    };
    const folderProps = {
        ...baseProps,
        recordings: [first, second],
        initialFolderOrganization: {
            folders: [rootFolder, personalChildFolder, organization],
            assignments: [
                { recordingId: first.id, folderId: personalChildFolder.id },
                { recordingId: second.id, folderId: personalChildFolder.id },
            ],
        },
    };
    it.each([
        "palette",
        "search",
    ])("opens a %s item outside the folder in Recent with working list navigation", (source) => {
        const outside = recording("outside", "Outside folder");
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=personal-child&recording=first",
        );
        render(
            <Workstation
                {...folderProps}
                recordings={[first, second, outside]}
            />,
        );
        expect(
            screen.queryByRole("button", { name: outside.filename }),
        ).toBeNull();
        act(() => {
            if (source === "palette")
                mocks.paletteProps?.onSelectRecording?.(outside);
            else
                mocks.paletteProps?.onOpenSearchHit?.({
                    id: outside.id,
                    title: outside.filename,
                    snippet: null,
                    href: "/dashboard?recording=outside",
                });
        });
        expect(screen.getByTestId("location").textContent).toBe("recent");
        expect(
            screen
                .getByRole("button", { name: outside.filename })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(window.location.search).toBe("?recording=outside");
        fireEvent.keyDown(window, { key: "k" });
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
    });
    it("opens a cross-scope search hit in its known Organization folder", () => {
        const shared = {
            ...recording("shared", "Shared outside folder"),
            view: "org" as const,
            isOwn: false,
        };
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=personal-child&recording=first",
        );
        render(
            <Workstation
                {...folderProps}
                initialFolderOrganization={{
                    ...folderProps.initialFolderOrganization,
                    assignments: [
                        ...folderProps.initialFolderOrganization.assignments,
                        { recordingId: shared.id, folderId: organization.id },
                    ],
                }}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );
        act(() => {
            mocks.paletteProps?.onOpenSearchHit?.({
                id: shared.id,
                title: shared.filename,
                snippet: null,
                href: "/dashboard?recording=shared&view=org",
            });
        });
        expect(screen.getByTestId("location").textContent).toBe(
            organization.id,
        );
        expect(
            screen
                .getByRole("button", { name: shared.filename })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(window.location.search).toBe(
            "?folder=org-root&recording=shared&view=org",
        );
    });
    it.each([
        false,
        true,
    ])("restores the phone folder list on Back after opening an item: missing state=%s", async (missingState) => {
        render(<Workstation {...folderProps} />);
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        expect(window.history.state.mobileView).toBe("list");
        if (missingState)
            window.history.replaceState(null, "", window.location.href);
        fireEvent.click(screen.getByRole("button", { name: second.filename }));
        expect(window.history.state.mobileView).toBe("detail");
        const list = screen.getByRole("region", { name: "Recent recordings" });
        expect(list.parentElement?.className).toContain("hidden");
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByTestId("location").textContent).toBe(
            personalChildFolder.id,
        );
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(list.parentElement?.className).not.toContain("hidden");
        expect(window.history.state.mobileView).toBe("list");
        await act(async () => {
            window.history.forward();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(list.parentElement?.className).toContain("hidden");
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
    });
    it.each([
        "personal-child",
        "personal-child.list",
    ])("consumes a Google export return before an item link and requests the matching export dialog: %s", (googleExport) => {
        window.history.replaceState(
            {},
            "",
            `/dashboard?folder=personal-child&recording=second&googleExport=${googleExport}`,
        );
        render(<Workstation {...folderProps} />);
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(mocks.settingsProps?.folder.id).toBe("personal-child");
        expect(mocks.settingsProps?.reopenExport).toBe(
            googleExport.endsWith(".list") ? "list" : "form",
        );
        expect(window.location.search).toBe(
            "?folder=personal-child&recording=second",
        );
        act(() => mocks.settingsProps?.onReopenHandled?.());
        expect(mocks.settingsProps?.reopenExport).toBeUndefined();
        act(() => mocks.settingsProps?.onOpenChange(false));
        expect(
            screen.queryByText("Folder settings", { selector: "div" }),
        ).toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "Folder settings" }),
        );
        expect(mocks.settingsProps?.reopenExport).toBeUndefined();
    });
    it.each([
        false,
        true,
    ])("keeps the item being read when opening Recent: Organization account=%s", (isOrgAccount) => {
        const pool = [first, second].map((item) =>
            isOrgAccount
                ? { ...item, view: "org" as const, isOwn: true }
                : item,
        );
        window.history.replaceState(
            {},
            "",
            `/dashboard?folder=${isOrgAccount ? organization.id : personalChildFolder.id}&recording=second${isOrgAccount ? "&view=org" : ""}`,
        );
        render(
            <Workstation
                {...folderProps}
                recordings={isOrgAccount ? [] : pool}
                isOrgAccount={isOrgAccount}
                organizationLibrary={
                    isOrgAccount
                        ? {
                              recordings: pool,
                              transcriptions: new Map(),
                              transcriptVariants: new Map(),
                          }
                        : null
                }
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(screen.getByTestId("location").textContent).toBe("recent");
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(
            new URLSearchParams(window.location.search).get("recording"),
        ).toBe("second");
        expect(new URLSearchParams(window.location.search).has("folder")).toBe(
            false,
        );
    });
    it("chooses the newest Recent item when the item being read belongs only to the Organization", () => {
        const shared = {
            ...recording("shared", "Shared"),
            view: "org" as const,
            isOwn: false,
        };
        const newest = { ...second, startTime: "2026-10-17T10:00:00Z" };
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=org-root&recording=shared&view=org",
        );
        render(
            <Workstation
                {...folderProps}
                recordings={[first, newest]}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(window.location.search).toBe("?recording=second");
    });
    it("keeps the item being read when opening a folder containing it in a descendant", () => {
        const nested = {
            ...personalChildFolder,
            id: "nested",
            parentId: personalChildFolder.id,
        };
        window.history.replaceState({}, "", "/dashboard?recording=second");
        render(
            <Workstation
                {...folderProps}
                initialFolderOrganization={{
                    folders: [
                        ...folderProps.initialFolderOrganization.folders,
                        nested,
                    ],
                    assignments: [
                        {
                            recordingId: first.id,
                            folderId: personalChildFolder.id,
                        },
                        { recordingId: second.id, folderId: nested.id },
                    ],
                }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(window.location.search).toBe(
            "?folder=personal-child&recording=second",
        );
    });
    it("chooses the newest visible item only when the current one is outside the opened folder", () => {
        const older = { ...first, startTime: "2026-10-15T10:00:00Z" };
        const newest = { ...second, startTime: "2026-10-16T10:00:00Z" };
        const outside = recording("outside", "Outside");
        window.history.replaceState({}, "", "/dashboard?recording=outside");
        render(
            <Workstation
                {...folderProps}
                recordings={[older, newest, outside]}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
    });
    it("restores the previous item with Back within a folder without pushing automatic selection", async () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=personal-child&recording=second",
        );
        const push = vi.spyOn(window.history, "pushState");
        render(<Workstation {...folderProps} />);
        expect(push).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole("button", { name: "First recording" }),
        );
        expect(push).toHaveBeenCalledTimes(1);
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        expect(push).toHaveBeenCalledTimes(1);
        push.mockRestore();
    });
    it.each([
        rootFolder.id,
        personalChildFolder.id,
    ])("opens old folder-only links and writes both item and folder: %s", (folderId) => {
        window.history.replaceState({}, "", `/dashboard?folder=${folderId}`);
        render(<Workstation {...folderProps} />);
        expect(screen.getByTestId("location").textContent).toBe(folderId);
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(new URLSearchParams(window.location.search).get("folder")).toBe(
            folderId,
        );
        expect(
            new URLSearchParams(window.location.search).get("recording"),
        ).toBe("first");
    });
    it("retains a folder while selecting its items and restores it from the combined URL", () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=personal-child&recording=second",
        );
        render(<Workstation {...folderProps} />);
        expect(screen.getByTestId("location").textContent).toBe(
            "personal-child",
        );
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "First recording" }),
        );
        expect(window.location.search).toBe(
            "?folder=personal-child&recording=first",
        );
        fireEvent.keyDown(window, { key: "j" });
        expect(window.location.search).toBe(
            "?folder=personal-child&recording=second",
        );
    });
    it("opens a folder from the command palette and keeps the location when opening an item", () => {
        render(<Workstation {...folderProps} />);
        act(() => mocks.paletteProps?.onSelectFolder?.(personalChildFolder));
        expect(screen.getByTestId("location").textContent).toBe(
            "personal-child",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Second recording" }),
        );
        expect(window.location.search).toBe(
            "?folder=personal-child&recording=second",
        );
    });
    it("keeps folders created while a deletion request is pending", async () => {
        let finishDelete: ((response: Response) => void) | undefined;
        const created = {
            ...personalChildFolder,
            id: "concurrent-folder",
            name: "Created during deletion",
        };
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === "DELETE")
                    return new Promise<Response>((resolve) => {
                        finishDelete = resolve;
                    });
                return Response.json({ folder: created });
            }),
        );
        render(<Workstation {...folderProps} />);
        fireEvent.click(
            screen.getByRole("button", { name: "Folder settings" }),
        );
        let deletion: Promise<void> | undefined;
        act(() => {
            deletion = mocks.settingsProps?.onDelete(personalChildFolder.id);
        });
        await act(async () => {
            await mocks.settingsProps?.onCreate(rootFolder.id, created.name);
        });
        expect(
            mocks.paletteProps?.folders?.some(
                (folder) => folder.id === created.id,
            ),
        ).toBe(true);
        await act(async () => {
            finishDelete?.(Response.json({ ok: true }));
            await deletion;
        });
        expect(
            mocks.paletteProps?.folders?.some(
                (folder) => folder.id === created.id,
            ),
        ).toBe(true);
        expect(
            mocks.paletteProps?.folders?.some(
                (folder) => folder.id === personalChildFolder.id,
            ),
        ).toBe(false);
        vi.unstubAllGlobals();
    });
    it("pushes detail history when opening the folder's auto-selected item with the same URL", async () => {
        render(<Workstation {...folderProps} />);
        fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
        const folderUrl = window.location.search;
        fireEvent.click(screen.getByRole("button", { name: first.filename }));
        expect(window.location.search).toBe(folderUrl);
        expect(window.history.state.mobileView).toBe("detail");
        await act(async () => {
            window.history.back();
            await new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
        });
        expect(window.location.search).toBe(folderUrl);
        expect(window.history.state.mobileView).toBe("list");
        expect(
            screen.getByRole("region", { name: "Recent recordings" })
                .parentElement?.className,
        ).not.toContain("hidden");
    });
    it("returns from a deleted Organization folder to its parent, keeps the visible item, and re-enables j/k", async () => {
        const orgChild = {
            ...personalChildFolder,
            id: "org-child",
            parentId: organization.id,
            scope: "org" as const,
        };
        const sharedFirst = { ...first, view: "org" as const, isOwn: false };
        const sharedSecond = { ...second, view: "org" as const, isOwn: false };
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=org-child&recording=first&view=org&googleExport=org-child.list",
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ ok: true })),
        );
        render(
            <Workstation
                {...folderProps}
                initialFolderOrganization={{
                    folders: [
                        ...folderProps.initialFolderOrganization.folders,
                        orgChild,
                    ],
                    assignments: [
                        { recordingId: first.id, folderId: orgChild.id },
                        { recordingId: second.id, folderId: organization.id },
                    ],
                }}
                organizationLibrary={{
                    recordings: [sharedFirst, sharedSecond],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );
        await act(async () => {
            await mocks.settingsProps?.onDelete(orgChild.id);
        });
        expect(screen.getByTestId("location").textContent).toBe("org-root");
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(window.location.search).toBe(
            "?folder=org-root&recording=first&view=org",
        );
        fireEvent.keyDown(window, { key: "j" });
        expect(screen.getByText("Selected: Second recording")).toBeTruthy();
        vi.unstubAllGlobals();
    });
    it("keeps Organization job status separate from the owner's private job", () => {
        const shared = { ...first, view: "org" as const, isOwn: true };
        mocks.inFlightActions = new Map([["first", "transcribing"]]);
        window.history.replaceState({}, "", "/dashboard?folder=org-root");
        const props = {
            ...folderProps,
            organizationLibrary: {
                recordings: [shared],
                transcriptions: new Map(),
                transcriptVariants: new Map(),
            },
        };
        const { rerender } = render(<Workstation {...props} />);
        expect(screen.getByTestId("list-actions").textContent).toBe("[]");
        mocks.inFlightActions = new Map([["org:first", "transcribing"]]);
        rerender(<Workstation {...props} />);
        expect(screen.getByTestId("list-actions").textContent).toBe(
            '[["first","transcribing"]]',
        );
    });
    it("uses the Organization for the organization account's Recent and omits Private navigation", () => {
        const shared = { ...first, view: "org" as const, isOwn: false };
        render(
            <Workstation
                {...folderProps}
                recordings={[]}
                isOrgAccount
                canCurate
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );
        expect(screen.getByTestId("location").textContent).toBe("recent");
        expect(screen.getByText("Selected: First recording")).toBeTruthy();
        expect(
            mocks.paletteProps?.folders?.every(
                (folder) => folder.scope === "org",
            ),
        ).toBe(true);
        expect(window.location.search).toBe("?recording=first&view=org");
        fireEvent.click(
            within(
                screen.getByRole("region", { name: "Folder tree" }),
            ).getByRole("button", { name: "New folder" }),
        );
        expect(
            screen.getByRole("combobox", { name: "Parent folder" }).textContent,
        ).toBe("Organization");
    });
});
