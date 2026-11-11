// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import type { RecordingList } from "@/components/dashboard/recording-list";
import { Workstation } from "@/components/dashboard/workstation";
import type { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import type { MailDetailPane } from "@/components/mail/mail-detail-pane";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import type { OrgClientEvent } from "@/lib/events/types";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";
import type { RecordingFolder } from "@/types/folder";

const mock = vi.hoisted(() => ({
    list: vi.fn(),
    detail: vi.fn(),
    mail: vi.fn(),
    tree: vi.fn(),
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
    RecordingList: (props: ComponentProps<typeof RecordingList>) => {
        mock.list(props);
        return (
            <div>
                {props.recordings.map((item) => (
                    <button
                        type="button"
                        key={item.id}
                        onClick={() => props.onSelect(item)}
                    >
                        {item.filename}
                    </button>
                ))}
            </div>
        );
    },
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: (props: unknown) => {
        mock.detail(props);
        return <p>Item details</p>;
    },
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: (props: unknown) => {
        mock.mail(props);
        return <p>Mail details</p>;
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
    FolderTree: (props: unknown) => {
        mock.tree(props);
        return null;
    },
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

const openA: RecordingFolder = {
    ...root,
    id: "a",
    parentId: "org",
    kind: "custom",
    name: "Open A",
};
const openB: RecordingFolder = { ...openA, id: "b", name: "Open B" };
const own = { ...props.recordings[0], id: "item", view: "private" as const };
const assignments = [{ recordingId: own.id, folderId: folder.id }];
function pane(): ComponentProps<typeof WorkstationDetailPane> {
    return mock.detail.mock.lastCall?.[0];
}
function list(): ComponentProps<typeof RecordingList> {
    return mock.list.mock.lastCall?.[0];
}
function mount(extra: Partial<ComponentProps<typeof Workstation>> = {}) {
    return render(
        <RestrictedFolderProvider writable userId="owner">
            <ConfirmDialogProvider>
                <Workstation
                    {...props}
                    recordings={[own]}
                    initialFolderOrganization={{
                        folders: [
                            root,
                            { ...folder, access: true },
                            openA,
                            openB,
                        ],
                        assignments,
                    }}
                    {...extra}
                />
            </ConfirmDialogProvider>
        </RestrictedFolderProvider>,
    );
}
it.each([
    "audio",
    "mail",
] as const)("includes authorized received %s for the local Organization curator, with counts and read-only owner content", async (kind) => {
    const received = {
        ...own,
        kind,
        isOwn: false,
        view: "received" as const,
        filename: `Withheld ${kind}`,
    };
    const content = {
        source: "whisper",
        text: "Owner's private transcript",
        turns: [
            {
                speaker: "Owner's speaker",
                text: "Owner content",
                startMs: 0,
                endMs: 10,
            },
        ],
    };
    window.history.replaceState({}, "", "/dashboard?folder=locked");
    mount({
        userId: "org",
        isOrgAccount: true,
        canCurate: true,
        recordings: [received],
        transcriptions: new Map([[own.id, content]]),
        transcriptVariants: new Map([[own.id, [content]]]),
    });
    fireEvent.click(
        await screen.findByRole("button", { name: received.filename }),
    );
    expect(list().recordings).toEqual([received]);
    expect(list().transcriptions.get(own.id)).toEqual(content);
    const navigation = mock.tree.mock.lastCall?.[0].navigation;
    expect(navigation.counts.get("locked")).toBe(1);
    expect(navigation.counts.get("org")).toBe(1);
    if (kind === "audio") {
        expect(pane().currentRecording?.view).toBe("received");
        expect(pane().currentTranscription).toEqual(content);
        expect(pane().transcripts).toEqual([content]);
        expect(pane().transcriptReadOnly).toBe(true);
    } else {
        const mail: ComponentProps<typeof MailDetailPane> =
            mock.mail.mock.lastCall?.[0];
        expect(mail.mail).toEqual(received);
        expect(mail.shared).toBe(false);
    }
    expect(mock.observe).not.toHaveBeenCalled();
});
it("moves open A to B while retaining R, with PATCH and no publication warning", async () => {
    const initial = [...assignments, { recordingId: own.id, folderId: "a" }];
    mount({
        initialFolderOrganization: {
            folders: [root, { ...folder, access: true }, openA, openB],
            assignments: initial,
        },
    });
    await act(async () => {
        await pane().onMoveBetweenFolders?.(own.id, "a", "b");
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
        "/api/recordings/item/folders",
        expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ fromFolderId: "a", toFolderId: "b" }),
        }),
    );
    expect(pane().folderAssignments).toEqual([
        ...assignments,
        { recordingId: own.id, folderId: "b" },
    ]);
});
it.each([
    "filing",
    "move",
])("rolls back a rejected fetch after confirmed %s", async (action) => {
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    let result!: Promise<unknown>;
    act(() => {
        result = (
            action === "filing"
                ? pane().onAddToFolder(own.id, "b")
                : (pane().onMoveBetweenFolders?.(own.id, folder.id, "b") ??
                  Promise.resolve())
        ).catch((error: unknown) => error);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(
        screen.getByRole("button", { name: "Share with the Organization" }),
    );
    await act(async () => {
        expect(await result).toBeInstanceOf(TypeError);
    });
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/recordings/item/folders",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ folderId: "b" }),
        }),
    );
    expect(pane().folderAssignments).toEqual(assignments);
});
it.each([
    403, 409,
])("refreshes stale filing/move authority after %s without SSE and keeps selection", async (status) => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            Response.json(
                {
                    code:
                        status === 403
                            ? "RESTRICTED_FOLDER_NO_ACCESS"
                            : "CONFLICT",
                    error: "refused",
                },
                { status },
            ),
        ),
    );
    const initial = [...assignments, { recordingId: own.id, folderId: "a" }];
    window.history.replaceState({}, "", "/dashboard?recording=item");
    mount({
        initialFolderOrganization: {
            folders: [root, { ...folder, access: true }, openA, openB],
            assignments: initial,
        },
    });
    for (const action of [
        () => pane().onAddToFolder(own.id, "b"),
        () => pane().onMoveBetweenFolders?.(own.id, "a", "b"),
    ]) {
        mock.refresh.mockClear();
        await act(async () => {
            await action()?.catch(() => {});
        });
        await waitFor(() => expect(mock.refresh).toHaveBeenCalledTimes(1));
        expect(pane().folderAssignments).toEqual(initial);
        expect(pane().currentRecording?.id).toBe(own.id);
        expect(
            new URLSearchParams(window.location.search).get("recording"),
        ).toBe(own.id);
    }
});
