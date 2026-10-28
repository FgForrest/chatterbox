// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import {
    type ComponentProps,
    type ReactNode,
    type Ref,
    useImperativeHandle,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPlayerHandle } from "@/components/dashboard/recording-player";
import { Workstation } from "@/components/dashboard/workstation";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const router = vi.hoisted(() => ({
    canonicalUrl: "/dashboard",
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock("@/components/meetings/recording-agenda", () => ({
    RecordingAgenda: ({
        children,
    }: {
        children: (parts: {
            notice: ReactNode;
            agenda: ReactNode;
            nextMeeting: ReactNode;
        }) => ReactNode;
    }) => children({ notice: null, agenda: null, nextMeeting: null }),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({
        refresh: router.refresh,
        push: router.push,
        replace: router.replace,
    }),
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
vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        custom: vi.fn(),
        dismiss: vi.fn(),
    },
}));
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
    FolderTree: ({
        selectedFolderId,
        recordings,
    }: {
        selectedFolderId: string | null;
        recordings: Recording[];
    }) => (
        <>
            <output data-testid="selected-folder">
                {selectedFolderId ?? "recent"}
            </output>
            <output data-testid="library-ids">
                {recordings.map((item) => item.id).join(",")}
            </output>
        </>
    ),
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: ({ mail }: { mail: Recording }) => <h1>{mail.filename}</h1>,
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
    for (const method of ["push", "replace"] as const) {
        router[method].mockReset().mockImplementation((url: string) => {
            router.canonicalUrl = url;
            window.history[method === "push" ? "pushState" : "replaceState"](
                { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } },
                "",
                url,
            );
        });
    }
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

const mail: Recording = {
    ...unfiled,
    id: "mail-nelra",
    filename: "Nelra project update",
    kind: "mail",
    startTime: "2026-10-22T10:00:00.000Z",
};
const shared: Recording = {
    ...unfiled,
    id: "shared-vorla",
    filename: "Vorla research notes",
    view: "org",
    isOwn: false,
};
const privateFolder: RecordingFolder = {
    id: "folder-fenra",
    name: "Fenra research",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 1,
};
const orgFolder: RecordingFolder = {
    ...privateFolder,
    id: "folder-vorla",
    name: "Vorla Organization",
    kind: "public",
    scope: "org",
};
const arrivals: Recording[] = [
    {
        ...filed,
        id: "arrival-audio-zalno",
        filename: "Zalno new recording",
        startTime: "2026-10-22T13:00:00.000Z",
    },
    {
        ...mail,
        id: "arrival-mail-zelra",
        filename: "Zelra new mail",
        startTime: "2026-10-22T14:00:00.000Z",
    },
    {
        ...shared,
        id: "arrival-org-zorla",
        filename: "Zorla new shared recording",
        startTime: "2026-10-22T15:00:00.000Z",
    },
];
const arrivalProps: ComponentProps<typeof Workstation> = {
    ...props,
    recordings: [...props.recordings, mail],
    organizationLibrary: {
        recordings: [shared],
        transcriptions: new Map(),
        transcriptVariants: new Map(),
    },
    initialFolderOrganization: {
        folders: [privateFolder, orgFolder],
        assignments: [
            ...[filed, unfiled, mail].map((item) => ({
                recordingId: item.id,
                folderId: privateFolder.id,
            })),
            { recordingId: shared.id, folderId: orgFolder.id },
        ],
    },
};

async function selectBeforeArrival(
    selected: Recording,
    folder: RecordingFolder | null,
) {
    const initialUrl = folder ? `/dashboard?folder=${folder.id}` : "/dashboard";
    router.canonicalUrl = initialUrl;
    window.history.replaceState(
        { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } },
        "",
        initialUrl,
    );
    const view = render(<Workstation {...arrivalProps} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: selected.filename }));
    await screen.findByRole("heading", { name: selected.filename });
    return view;
}

async function deliverArrivals(rerender: (ui: ReactNode) => void) {
    const previousIds = screen
        .getByTestId("library-ids")
        .textContent?.split(",");
    for (const arrival of arrivals)
        expect(previousIds).not.toContain(arrival.id);
    await act(async () => {
        router.refresh();
        window.history.replaceState(
            { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } },
            "",
            router.canonicalUrl,
        );
        rerender(
            <Workstation
                {...arrivalProps}
                recordings={[
                    ...arrivals.filter((item) => item.view !== "org"),
                    ...arrivalProps.recordings.map((item) => ({ ...item })),
                ]}
                organizationLibrary={{
                    recordings: [
                        ...arrivals.filter((item) => item.view === "org"),
                        { ...shared },
                    ],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
                initialFolderOrganization={{
                    ...arrivalProps.initialFolderOrganization,
                    assignments: [
                        ...arrivalProps.initialFolderOrganization.assignments,
                        ...arrivals.map((item) => ({
                            recordingId: item.id,
                            folderId:
                                item.view === "org"
                                    ? orgFolder.id
                                    : privateFolder.id,
                        })),
                    ],
                }}
            />,
        );
    });
    const ids = screen.getByTestId("library-ids").textContent?.split(",");
    for (const arrival of arrivals) expect(ids).toContain(arrival.id);
}

describe("arrival selection", () => {
    it.each([
        { name: "audio in Recent", selected: unfiled, folder: null },
        {
            name: "audio in a private folder",
            selected: unfiled,
            folder: privateFolder,
        },
        { name: "mail in Recent", selected: mail, folder: null },
        {
            name: "mail in a private folder",
            selected: mail,
            folder: privateFolder,
        },
        {
            name: "Organization audio in a folder",
            selected: shared,
            folder: orgFolder,
        },
    ])("keeps $name selected when newer audio, mail and Organization IDs arrive", async ({
        selected,
        folder,
    }) => {
        const { rerender } = await selectBeforeArrival(selected, folder);
        const selectionUrl = window.location.href;
        expect(new URL(selectionUrl).searchParams.get("recording")).toBe(
            selected.id,
        );
        await deliverArrivals(rerender);
        expect(window.location.href).toBe(selectionUrl);
        expect(new URL(router.canonicalUrl, window.location.origin).href).toBe(
            selectionUrl,
        );
        expect(screen.getByTestId("selected-folder").textContent).toBe(
            folder?.id ?? "recent",
        );
        expect(
            screen.getByRole("heading", { name: selected.filename }),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("button", { name: selected.filename })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(
            screen
                .getByRole("region", { name: "Recordings" })
                .parentElement?.classList.contains("hidden"),
        ).toBe(true);
    });

    it("keeps the selection when Next's own history writes include internal markers", async () => {
        const { rerender } = await selectBeforeArrival(unfiled, privateFolder);
        expect(window.history.pushState).toHaveBeenLastCalledWith(
            { mobileView: "detail" },
            "",
            expect.stringContaining(`recording=${unfiled.id}`),
        );
        const url = window.location.href;
        expect(new URL(router.canonicalUrl, window.location.origin).href).toBe(
            url,
        );
        await deliverArrivals(rerender);
        expect(window.location.href).toBe(url);
        expect(
            screen.getByRole("heading", { name: unfiled.filename }),
        ).toBeTruthy();
    });
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

    it("synchronizes native selections with Next without router navigation", async () => {
        await selectUnfiled();
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(
            new URL(
                router.canonicalUrl,
                window.location.origin,
            ).searchParams.get("recording"),
        ).toBe(unfiled.id);
    });

    it("does not refresh the dashboard using the previous item's transcript state", async () => {
        await selectUnfiled();
        expect(router.refresh).not.toHaveBeenCalled();
    });
});
