// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { type ComponentProps, type Ref, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPlayerHandle } from "@/components/dashboard/recording-player";
import { Workstation } from "@/components/dashboard/workstation";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { Recording } from "@/types/recording";

const router = vi.hoisted(() => ({
    canonicalUrl: "/dashboard",
    refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: router.refresh }),
    useSearchParams: () =>
        new URL(router.canonicalUrl, window.location.origin).searchParams,
}));
vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted:
        () =>
        (
            value: string | { message: string },
            params?: Record<string, unknown>,
        ) => {
            const message = typeof value === "string" ? value : value.message;
            return message.replace(/\{(\w+)\}/g, (_, key: string) =>
                String(params?.[key] ?? ""),
            );
        },
}));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/app-chrome-provider", () => ({
    useAppChrome: () => ({
        settingsOpen: false,
        onboardingOpen: false,
        paletteOpen: false,
        shortcutsOpen: false,
        theme: "light",
        isAutoSyncing: false,
        lastSyncResult: null,
    }),
}));
vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: vi.fn() }));
vi.mock("@/hooks/use-share-refusal", () => ({
    useShareRefusal: () => vi.fn(),
}));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({
        inFlightActions: new Map(),
        observeTranscriptionById: vi.fn(),
        transcribeById: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: () => ({
        pendingUploads: [],
        uploadInputRef: { current: null },
        selectedFile: null,
    }),
}));
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: null,
        isSummarizing: false,
        summaryExpanded: false,
        summaryProfileOptions: [],
        summaryProfilesLoading: false,
    }),
}));
vi.mock("@/components/tasks/task-api", () => ({
    onTasksChanged: () => () => {},
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: () => null,
}));
vi.mock("@/components/dashboard/library-location-header", () => ({
    LibraryLocationHeader: () => null,
}));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/dashboard/upload-dialog", () => ({
    UploadDialog: () => null,
    uploadFolderOptions: () => [],
    uploadFolderParents: () => [],
}));
vi.mock("@/components/dashboard/first-level-folder-dialog", () => ({
    FirstLevelFolderDialog: () => null,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: ({
        recordings,
        currentRecording,
        onSelect,
    }: {
        recordings: Recording[];
        currentRecording: Recording | null;
        onSelect: (recording: Recording) => void;
    }) => (
        <section aria-label="Recordings">
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
        </section>
    ),
}));
vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingPlayerHeader: ({ recording }: { recording: Recording }) => (
        <h1>{recording.filename}</h1>
    ),
}));
vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: ({ ref }: { ref: Ref<RecordingPlayerHandle> }) => {
        useImperativeHandle(ref, () => ({
            playFrom: vi.fn(),
            seekTo: vi.fn(),
            pause: vi.fn(),
            subscribe: () => () => {},
        }));
        return null;
    },
    transcriptPlayback: () => ({
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        subscribe: () => () => {},
    }),
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));
vi.mock("@/components/recordings/erase-recording-menu", () => ({
    EraseRecordingMenu: () => null,
}));

const filed: Recording = {
    id: "filed-velno",
    filename: "Project planning",
    deviceSn: "local",
    duration: 60_000,
    filesize: 1024,
    startTime: "2026-10-22T12:00:00.000Z",
};
const unfiled: Recording = {
    ...filed,
    id: "unfiled-fenra",
    filename: "Roadmap ideas",
    startTime: "2026-10-22T11:00:00.000Z",
};
const filedProcessing = processingFixture({
    itemId: filed.id,
    kind: "audio",
    legacy: false,
    manualOnly: false,
    phases: {
        categorize: { state: "done", generation: 1, at: filed.startTime },
    },
    profile: null,
    placements: [],
    intents: [],
    outputs: { transcript: true, learn: false, summary: false },
    jobs: { transcription: null, summary: null },
    failures: [],
    processAgain: false,
    processAgainReason: null,
    learnFindingsWaiting: 0,
    taskReviewWaiting: 0,
});
const unfiledProcessing = processingFixture({
    ...filedProcessing,
    itemId: unfiled.id,
    phases: {
        categorize: {
            state: "waiting",
            reason: "needs_folder",
            generation: 1,
            at: unfiled.startTime,
        },
    },
    outputs: { transcript: false, learn: false, summary: false },
});
const panel: CategorizationPanelPresentation = {
    itemId: unfiled.id,
    folders: [],
    selectedFolderIds: [],
    profiles: [],
    canCreateOrganizationFolders: false,
    currentProfile: null,
    currentManualOnly: false,
    resolution: { status: "choose", candidates: [] },
};
const props: ComponentProps<typeof Workstation> = {
    recordings: [filed, unfiled],
    transcriptions: new Map([
        [filed.id, { text: "Planning transcript", source: "riffado" }],
    ]),
    initialSettings: {
        dateTimeFormat: "relative",
        recordingListSortOrder: "newest",
        chatterKindFilter: "all",
        itemsPerPage: 50,
        listDensity: "comfortable",
        theme: "light",
        defaultPlaybackSpeed: 1,
        defaultVolume: 75,
        autoPlayNext: false,
        playerScrubber: "waveform",
        syncInterval: 300_000,
        autoSyncEnabled: false,
        syncOnMount: false,
        syncOnVisibilityChange: false,
        syncNotifications: false,
        browserNotifications: false,
        onboardingCompleted: true,
    },
    plaudNeedsReconnect: false,
    isHosted: false,
    exportProviders: { filesystem: false, googleDrive: false, mail: false },
    initialFolderOrganization: { folders: [], assignments: [] },
};

beforeEach(() => {
    router.canonicalUrl = "/dashboard";
    router.refresh.mockClear();
    window.history.replaceState(
        { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } },
        "",
        "/dashboard",
    );
    for (const method of ["pushState", "replaceState"] as const) {
        const original = window.history[method].bind(window.history);
        vi.spyOn(window.history, method).mockImplementation(
            (data, unused, url) => {
                if (data?.__NA || data?._N) return original(data, unused, url);
                const nextState = {
                    ...data,
                    __NA: window.history.state?.__NA,
                    __PRIVATE_NEXTJS_INTERNALS_TREE:
                        window.history.state?.__PRIVATE_NEXTJS_INTERNALS_TREE,
                };
                if (url) router.canonicalUrl = String(url);
                return original(nextState, unused, url);
            },
        );
    }
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/categorize")) return Response.json(panel);
            if (url.includes("?processing=1"))
                return Response.json({
                    processing: url.includes(unfiled.id)
                        ? unfiledProcessing
                        : filedProcessing,
                });
            return Response.json({});
        }),
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function selectUnfiled() {
    const view = render(<Workstation {...props} />);
    await act(async () => {});
    expect(screen.getByRole("heading", { name: filed.filename })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: unfiled.filename }));
    await screen.findByRole("heading", { name: "Categorize recording" });
    return view;
}

describe("unfiled selection", () => {
    it("keeps the Categorize card and selection URL after a router commit", async () => {
        const { rerender } = await selectUnfiled();
        act(() => {
            window.history.replaceState(
                {
                    __NA: true,
                    __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] },
                },
                "",
                router.canonicalUrl,
            );
        });
        rerender(<Workstation {...props} recordings={[...props.recordings]} />);
        expect(window.location.search).toBe(`?recording=${unfiled.id}`);
        expect(
            screen.getByRole("heading", { name: unfiled.filename }),
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { name: "Categorize recording" }),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("button", { name: unfiled.filename })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(
            screen
                .getByRole("region", { name: "Recordings" })
                .parentElement?.classList.contains("hidden"),
        ).toBe(true);
    });

    it("lets Next synchronize selection writes without passing its internal history keys", async () => {
        await selectUnfiled();
        const push = vi.mocked(window.history.pushState);
        expect(push).toHaveBeenLastCalledWith(
            { mobileView: "detail" },
            "",
            `/dashboard?recording=${unfiled.id}`,
        );
        expect(router.canonicalUrl).toBe(`/dashboard?recording=${unfiled.id}`);
    });

    it("does not refresh the dashboard using the previous item's transcript state", async () => {
        await selectUnfiled();
        expect(router.refresh).not.toHaveBeenCalled();
    });
});
