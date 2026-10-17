// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workstation as WorkstationComponent } from "@/components/dashboard/workstation";
import type { UploadCompletionAction } from "@/hooks/use-upload-queue";
import type { Recording } from "@/types/recording";

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(),
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
}));

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string) => text,
}));

vi.mock("posthog-js", () => ({ default: { __loaded: false } }));

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

vi.mock("@/hooks/use-list-keyboard-nav", () => ({
    useListKeyboardNav: vi.fn(),
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
        inFlightActions: new Map(),
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

vi.mock("@/components/dashboard/workstation-header", () => ({
    WorkstationHeader: () => <div>Dashboard header</div>,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: ({
        recordings,
        currentRecording,
        onSelect,
        onOrganize,
        emptyState,
    }: {
        recordings: Recording[];
        currentRecording: Recording | null;
        onSelect: (recording: Recording) => void;
        onOrganize: () => void;
        emptyState?: React.ReactNode;
    }) => (
        <section aria-label="Recent recordings">
            <button type="button" onClick={onOrganize}>
                Organize
            </button>
            {recordings.map((recording) => (
                <button
                    type="button"
                    key={recording.id}
                    aria-pressed={currentRecording?.id === recording.id}
                    onClick={() => onSelect(recording)}
                >
                    {recording.filename}
                </button>
            ))}
            {recordings.length === 0 ? (
                <>
                    <p>No recordings yet.</p>
                    {emptyState}
                </>
            ) : null}
        </section>
    ),
}));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: ({ onNewFolder }: { onNewFolder?: () => void }) => (
        <section aria-label="Folder tree">
            <button type="button" onClick={onNewFolder}>
                New folder
            </button>
        </section>
    ),
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: ({
        currentRecording,
    }: {
        currentRecording: Recording | null;
    }) => <div>Selected: {currentRecording?.filename ?? "none"}</div>,
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
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
vi.mock("@/components/dashboard/folder-recording-pane", () => ({
    FolderRecordingPane: () => null,
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
    onboardingCapabilities: {
        googleConfigured: false,
        mailAvailable: false,
        mcpConnectorUrl: null,
        recorderStoreUrl: "https://store.example/recorder",
    },
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

beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.uploadOptions = null;
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

        fireEvent.click(screen.getByRole("button", { name: "Organize" }));
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

    it("leaves Organization-only content unselected for a personal account", () => {
        const shared = {
            ...recording("shared-1", "Shared recording"),
            view: "org" as const,
            isOwn: false,
        };

        render(
            <Workstation
                {...baseProps}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
            />,
        );

        expect(screen.getByText("Selected: none")).toBeTruthy();
        expect(screen.queryByText("Start with a folder")).toBeNull();
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

        fireEvent.click(screen.getByRole("button", { name: "Organize" }));
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

        fireEvent.click(screen.getByRole("button", { name: "Organize" }));
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
