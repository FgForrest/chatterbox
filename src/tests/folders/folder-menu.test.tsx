// @vitest-environment jsdom

import {
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { Workstation } from "@/components/dashboard/workstation";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
    RECORDING_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    RECORDING_SOURCE_SCOPE_DRAG_TYPES,
} from "@/lib/folders/drag";
import type { RecordingFolder } from "@/types/folder";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
    useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("@/components/app-chrome-provider", () => ({
    useAppChrome: () => ({
        settingsOpen: false,
        onboardingOpen: false,
        paletteOpen: false,
        shortcutsOpen: false,
        theme: "light",
        isAutoSyncing: false,
    }),
}));
vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: vi.fn() }));
vi.mock("@/hooks/use-share-refusal", () => ({
    useShareRefusal: () => vi.fn(),
}));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({ inFlightActions: new Map() }),
}));
vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: () => ({
        isUploading: false,
        pendingUploads: [],
        uploadInputRef: { current: null },
        selectedFile: null,
    }),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/dashboard/workstation-empty-state", () => ({
    WorkstationEmptyState: () => null,
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: () => null,
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: () => null,
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
        header,
        navigationContent,
    }: {
        header: ReactNode;
        navigationContent: ReactNode;
    }) => (
        <>
            {header}
            {navigationContent}
        </>
    ),
}));
vi.mock("@/components/dashboard/folder-export-actions", () => ({
    FolderExportActions: () => null,
}));
vi.mock("@/components/dashboard/folder-default-profiles", () => ({
    FolderDefaultProfiles: () => null,
}));

const privateRoot: RecordingFolder = {
    id: "private-root",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const privateFolder: RecordingFolder = {
    ...privateRoot,
    id: "cedar",
    name: "Cedar",
    parentId: privateRoot.id,
    kind: "custom",
};
const orgRoot: RecordingFolder = {
    ...privateRoot,
    id: "org-root",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const orgFolder: RecordingFolder = {
    ...orgRoot,
    id: "juniper",
    name: "Juniper",
    parentId: orgRoot.id,
    kind: "custom",
};
const props: ComponentProps<typeof Workstation> = {
    recordings: [],
    transcriptions: new Map(),
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
    initialFolderOrganization: {
        folders: [privateRoot, privateFolder, orgRoot, orgFolder],
        assignments: [],
    },
};

beforeEach(() => {
    refresh.mockClear();
    window.history.replaceState({}, "", "/dashboard");
});
afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});

function workstation(
    canCurate = false,
    isOrgAccount = false,
    sharedWithPeople = false,
    organization = props.initialFolderOrganization,
) {
    render(
        <ConfirmDialogProvider>
            <TooltipProvider>
                <Workstation
                    {...props}
                    initialFolderOrganization={{
                        ...organization,
                        folders: organization.folders.map((folder) =>
                            folder.id === privateFolder.id
                                ? { ...folder, sharedWithPeople }
                                : folder,
                        ),
                    }}
                    canCurate={canCurate}
                    isOrgAccount={isOrgAccount}
                />
            </TooltipProvider>
        </ConfirmDialogProvider>,
    );
}

describe("folder row menu", () => {
    it.each([
        {
            name: "Private",
            canCurate: false,
            isOrgAccount: false,
            allowed: true,
        },
        { name: "Cedar", canCurate: false, isOrgAccount: false, allowed: true },
        {
            name: "Organization",
            canCurate: false,
            isOrgAccount: false,
            allowed: false,
        },
        {
            name: "Juniper",
            canCurate: false,
            isOrgAccount: false,
            allowed: true,
        },
        {
            name: "Organization",
            canCurate: true,
            isOrgAccount: false,
            allowed: true,
        },
        {
            name: "Organization",
            canCurate: false,
            isOrgAccount: true,
            allowed: true,
        },
    ])("offers creation in $name: curator=$canCurate, Organization account=$isOrgAccount", ({
        name,
        canCurate,
        isOrgAccount,
        allowed,
    }) => {
        workstation(canCurate, isOrgAccount);
        fireEvent.pointerDown(
            screen.getByRole("button", { name: `Folder actions for ${name}` }),
            { button: 0, ctrlKey: false },
        );
        expect(
            screen
                .getAllByRole("menuitem")
                .map((item) => item.textContent?.trim()),
        ).toEqual([
            ...(allowed ? ["New subfolder"] : []),
            ...(name === "Private" ? [] : ["Prepare a meeting"]),
            "Folder settings",
        ]);
    });

    it("opens the same menu from a right-click anywhere on the row without navigating", () => {
        workstation();
        const trigger = screen.getByRole("button", {
            name: "Folder actions for Cedar",
        });
        const row = screen.getByRole("button", {
            name: "Cedar, 0 recordings",
        }).parentElement;
        if (!row) throw new Error("Missing folder row");
        const event = createEvent.contextMenu(row, {
            clientX: 60,
            clientY: 80,
        });
        fireEvent(row, event);
        expect(event.defaultPrevented).toBe(true);
        expect(
            screen.getByRole("menuitem", { name: "New subfolder" }),
        ).toBeTruthy();
        expect(
            new URLSearchParams(window.location.search).get("folder"),
        ).toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it.each([
        "ContextMenu",
        "F10",
    ])("opens the menu with %s on a focused folder", (key) => {
        workstation();
        const row = screen.getByRole("button", { name: "Cedar, 0 recordings" });
        row.focus();
        const event = createEvent.keyDown(row, {
            key,
            shiftKey: key === "F10",
        });
        fireEvent(row, event);
        expect(event.defaultPrevented).toBe(true);
        expect(
            screen.getByRole("menuitem", { name: "New subfolder" }),
        ).toBeTruthy();
    });

    it("opens the existing create panel focused on the child name and creates in the clicked folder", async () => {
        const fetchMock = vi.fn(async () =>
            Response.json({
                folder: {
                    ...privateFolder,
                    id: "birch",
                    name: "Birch",
                    parentId: privateFolder.id,
                },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        workstation();
        fireEvent.contextMenu(
            screen.getByRole("button", { name: "Cedar, 0 recordings" }),
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "New subfolder" }),
        );
        expect(screen.getByRole("dialog", { name: "Cedar" })).toBeTruthy();
        const name = screen.getByRole("textbox", {
            name: "New subfolder name",
        });
        await waitFor(() => expect(document.activeElement).toBe(name));
        fireEvent.change(name, { target: { value: "Birch" } });
        fireEvent.click(screen.getByRole("button", { name: "New subfolder" }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    parentId: privateFolder.id,
                    name: "Birch",
                }),
            }),
        );
    });

    it("keeps Folder settings in its ordinary mode", () => {
        workstation();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Folder actions for Cedar" }),
            { button: 0, ctrlKey: false },
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Folder settings" }),
        );
        expect(screen.getByRole("dialog", { name: "Cedar" })).toBeTruthy();
        expect(
            screen.queryByRole("textbox", { name: "New subfolder name" }),
        ).toBeNull();
        expect(
            screen.getByRole("button", { name: "New subfolder" }),
        ).toBeTruthy();
    });

    it.each([
        false,
        true,
    ])("offers only private destinations for a private folder with curator=%s", (canCurate) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        workstation(canCurate);
        fireEvent.contextMenu(
            screen.getByRole("button", { name: "Cedar, 0 recordings" }),
        );
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Folder settings" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
        const destinations = screen.getByRole("combobox", {
            name: "Destination folder",
        });
        expect(
            Array.from((destinations as HTMLSelectElement).options).map(
                (option) => option.value,
            ),
        ).toEqual([privateRoot.id]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        false,
        true,
    ])("refreshes owner item markers after filing into a folder with sharing=%s", async (sharedWithPeople) => {
        const fetchMock = vi.fn(async () => Response.json({}));
        vi.stubGlobal("fetch", fetchMock);
        workstation(false, false, sharedWithPeople);
        const transfer = {
            types: ["application/x-riffado-recording"],
            getData: (type: string) =>
                type === "application/x-riffado-recording" ? "audio" : "",
            setData: vi.fn(),
        };
        fireEvent.drop(
            screen.getByRole("button", { name: "Cedar, 0 recordings" }),
            { dataTransfer: transfer },
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/audio/folders",
                expect.objectContaining({ method: "POST" }),
            ),
        );
        await waitFor(() =>
            expect(refresh).toHaveBeenCalledTimes(sharedWithPeople ? 1 : 0),
        );
    });

    it("refreshes when a move prunes another shared ancestor placement", async () => {
        const child = {
            ...privateFolder,
            id: "child",
            name: "Branch",
            parentId: privateFolder.id,
        };
        const source = { ...privateFolder, id: "source", name: "Other folder" };
        window.history.replaceState({}, "", "/dashboard?folder=child");
        const fetchMock = vi.fn(async () => Response.json({}));
        vi.stubGlobal("fetch", fetchMock);
        workstation(false, false, true, {
            folders: [
                ...props.initialFolderOrganization.folders,
                child,
                source,
            ],
            assignments: [
                { recordingId: "audio", folderId: privateFolder.id },
                { recordingId: "audio", folderId: source.id },
            ],
        });
        const transfer = {
            types: [
                RECORDING_DRAG_TYPE,
                RECORDING_SOURCE_FOLDER_DRAG_TYPE,
                RECORDING_SOURCE_SCOPE_DRAG_TYPES.personal,
            ],
            getData: (type: string) =>
                type === RECORDING_DRAG_TYPE
                    ? "audio"
                    : type === RECORDING_SOURCE_FOLDER_DRAG_TYPE
                      ? source.id
                      : type === RECORDING_SOURCE_SCOPE_DRAG_TYPES.personal
                        ? "personal"
                        : "",
            setData: vi.fn(),
        };
        fireEvent.drop(
            await screen.findByRole("button", { name: "Branch, 0 recordings" }),
            { dataTransfer: transfer },
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/audio/folders",
                expect.objectContaining({ method: "PATCH" }),
            ),
        );
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    });

    it("shares the nested Organization creation rule with the location action", async () => {
        workstation();
        fireEvent.click(
            screen.getByRole("button", { name: "Juniper, 0 recordings" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "New subfolder" }));
        expect(screen.getByRole("dialog", { name: "Juniper" })).toBeTruthy();
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole("textbox", { name: "New subfolder name" }),
            ),
        );
    });
});
