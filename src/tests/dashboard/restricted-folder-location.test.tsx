// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workstation } from "@/components/dashboard/workstation";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import type { OrgClientEvent } from "@/lib/events/types";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";
import type { RecordingFolder } from "@/types/folder";

const mock = vi.hoisted(() => ({
    list: vi.fn(),
    detail: vi.fn(),
    tasks: vi.fn(),
    knowledge: vi.fn(),
    observe: vi.fn(),
    refresh: vi.fn(),
    actions: new Map(),
    event: null as ((event: OrgClientEvent) => void) | null,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mock.refresh }),
    useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => mock.refresh,
    noteDashboardUrlChange: vi.fn(),
}));
vi.mock("@/hooks/use-mail-refresh", () => ({ useMailRefresh: vi.fn() }));
vi.mock("@/hooks/use-org-events", () => ({
    useOrgEvents: (
        _enabled: boolean,
        listener: (event: OrgClientEvent) => void,
    ) => {
        mock.event = listener;
    },
}));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({
        inFlightActions: mock.actions,
        observeTranscriptionById: mock.observe,
        transcribeById: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: () => ({
        isUploading: false,
        pendingUploads: [],
        uploadInputRef: { current: null },
        selectedFile: null,
        handleUpload: vi.fn(),
        confirmUpload: vi.fn(),
        cancelUpload: vi.fn(),
        triggerUpload: vi.fn(),
    }),
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
        manualSync: vi.fn(),
    }),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: (props: unknown) => {
        mock.list(props);
        return <p>Item list</p>;
    },
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: (props: unknown) => {
        mock.detail(props);
        return <p>Item details</p>;
    },
}));
vi.mock("@/components/tasks/folder-tasks-panel", () => ({
    FolderTasksPanel: () => {
        mock.tasks();
        return null;
    },
}));
vi.mock("@/components/dashboard/folder-knowledge-panel", () => ({
    FolderKnowledgePanel: () => {
        mock.knowledge();
        return null;
    },
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: ({
        folders,
        onSelectFolder,
    }: {
        folders: RecordingFolder[];
        onSelectFolder: (folder: RecordingFolder) => void;
    }) => (
        <button type="button" onClick={() => onSelectFolder(folders[1])}>
            Open locked folder
        </button>
    ),
}));
const root: RecordingFolder = {
    id: "org",
    parentId: null,
    name: "Organization",
    kind: "public",
    scope: "org",
    version: 1,
    sortOrder: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "locked",
    parentId: "org",
    kind: "custom",
    name: "Acme pilot",
    restricted: true,
    access: false,
    managers: [],
    accessRequest: "none",
};
const props: ComponentProps<typeof Workstation> = {
    userId: "outsider",
    recordings: [
        {
            id: "elsewhere",
            filename: "Available elsewhere",
            isOwn: true,
            duration: 100,
            filesize: 10,
            deviceSn: "local",
            startTime: "2026-11-01T12:00:00Z",
        },
    ],
    transcriptions: new Map(),
    initialSettings: {
        ...INITIAL_SETTINGS_DEFAULTS,
        onboardingCompleted: true,
    },
    plaudNeedsReconnect: false,
    isHosted: false,
    exportProviders: { filesystem: false, googleDrive: false, mail: false },
    initialFolderOrganization: { folders: [root, folder], assignments: [] },
    organizationLibrary: {
        recordings: [],
        transcriptions: new Map(),
        transcriptVariants: new Map(),
    },
};
beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/dashboard");
});
it.each([
    "",
    "&recording=elsewhere",
    "&knowledge=1",
    "&tasks=1",
    "&meeting=stale",
])("does not mount or fetch item panels for a locked folder URL %s", (query) => {
    window.history.replaceState({}, "", `/dashboard?folder=locked${query}`);
    render(
        <RestrictedFolderProvider writable userId="outsider">
            <Workstation {...props} />
        </RestrictedFolderProvider>,
    );
    expect(
        screen.getByText("Only its audience and curators can see this folder."),
    ).toBeTruthy();
    expect(mock.list).not.toHaveBeenCalled();
    expect(mock.detail).not.toHaveBeenCalled();
    expect(mock.tasks).not.toHaveBeenCalled();
    expect(mock.knowledge).not.toHaveBeenCalled();
    expect(mock.observe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});
it("tree selection switches to the public empty state", () => {
    window.history.replaceState({}, "", "/dashboard");
    render(
        <RestrictedFolderProvider writable userId="outsider">
            <Workstation {...props} />
        </RestrictedFolderProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open locked folder" }));
    expect(
        screen.getByText("Only its audience and curators can see this folder."),
    ).toBeTruthy();
    expect(screen.queryByText("Item list")).toBeNull();
    expect(screen.queryByText("Item details")).toBeNull();
    expect(window.location.search).toBe("?folder=locked");
});
it("reloads structural tree events and polls while a restriction is running", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/dashboard?folder=locked");
    render(
        <Workstation
            {...props}
            initialFolderOrganization={{
                folders: [root, { ...folder, restricting: true }],
                assignments: [],
            }}
        />,
    );
    act(() => mock.event?.({ type: "tree" }));
    await act(async () => {
        vi.advanceTimersByTime(300);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
        vi.advanceTimersByTime(1700);
    });
    expect(mock.refresh).toHaveBeenCalledTimes(2);
});
