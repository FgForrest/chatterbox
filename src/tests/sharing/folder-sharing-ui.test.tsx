// @vitest-environment jsdom

import {
    act,
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { FolderSettingsPanel } from "@/components/dashboard/folder-settings-panel";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { uploadFolderOptions } from "@/components/dashboard/upload-dialog";
import { FolderPicker } from "@/components/recordings/folder-picker";
import {
    changeFolderShareRequest,
    ReceivedFolderDialog,
} from "@/components/sharing/folder-sharing";
import {
    PersonInvitations,
    PersonShareDialog,
    PersonSharingProvider,
} from "@/components/sharing/person-sharing";
import {
    LibraryPreferencesContext,
    useLibraryPreferencesState,
} from "@/hooks/use-library-preferences";
import { subscribeEvents } from "@/lib/events/client";
import { canCreateSubfolder } from "@/lib/folders/permissions";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const { refresh, notices } = vi.hoisted(() => ({
    refresh: vi.fn(),
    notices: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock("@/lib/events/client", () => ({
    subscribeEvents: vi.fn(() => () => {}),
}));
vi.mock("next-intl", () => {
    const translate = (
        source: string | { message: string },
        values?: Record<string, string | number>,
    ) =>
        (typeof source === "string" ? source : source.message)
            .replace(
                /\{count, plural, one \{([^}]+)\} other \{([^}]+)\}\}/g,
                (_match, one: string, other: string) =>
                    (Number(values?.count) === 1 ? one : other).replaceAll(
                        "#",
                        String(values?.count),
                    ),
            )
            .replace(/\{(\w+)\}/g, (match, key: string) =>
                values?.[key] === undefined ? match : String(values[key]),
            );
    return {
        useExtracted: () => translate,
        useLocale: () => "en",
        useFormatter: () => ({ dateTime: () => "2026-10-22" }),
    };
});
vi.mock("sonner", () => ({
    toast: {
        custom: notices,
        dismiss: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
    },
}));
vi.mock("@/components/dashboard/folder-default-profiles", () => ({
    FolderDefaultProfiles: () => <span>Processing defaults</span>,
}));
vi.mock("@/components/dashboard/folder-export-actions", () => ({
    FolderExportActions: () => null,
}));

const root: RecordingFolder = {
    id: "root",
    name: "Private",
    kind: "private",
    scope: "personal",
    parentId: null,
    sortOrder: 0,
    version: 0,
};
const privateFolder: RecordingFolder = {
    ...root,
    id: "mine",
    name: "Projects",
    parentId: "root",
    kind: "custom",
};
const outgoing: RecordingFolder = {
    ...privateFolder,
    id: "outgoing",
    name: "Research",
    sharedWithPeople: true,
};
const attached: RecordingFolder = {
    ...privateFolder,
    id: "attached",
    name: "Local research",
    receivedFolder: {
        shareId: "share",
        shareVersion: 1,
        ownerName: "Alex Morgan",
        originalName: "Owner research",
    },
};
const org: RecordingFolder = {
    ...root,
    id: "org",
    name: "Organization",
    kind: "public",
    scope: "org",
};
const folders = [root, privateFolder, outgoing, attached, org];
const recording: Recording = {
    id: "audio",
    filename: "Interview",
    duration: 1000,
    filesize: 10,
    startTime: "2026-10-22T10:00:00Z",
    deviceSn: "local",
    view: "received",
    isOwn: false,
    ownerName: "Alex Morgan",
};
const share = {
    id: "share",
    receiverUserId: "receiver",
    name: "Lena Fischer",
    email: "lena@example.com",
    state: "accepted",
    version: 1,
    invitedAt: new Date(),
    respondedAt: new Date(),
};
const invitation = {
    id: "invite",
    itemId: "source",
    kind: "folder" as const,
    title: "Owner research",
    ownerName: "Alex Morgan",
    ownerEmail: "alex@example.com",
    version: 0,
    invitedAt: new Date(),
};
let requests: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.clearAllMocks();
    requests = vi.fn(async (path: string, init?: RequestInit) => {
        if (init?.method)
            return Response.json({ success: true, shares: [share] });
        if (path.includes("/shares"))
            return Response.json({ shares: [share], invitations: [] });
        return Response.json({
            chatter: [],
            almanac: [],
            tasks: [],
            limited: false,
        });
    });
    vi.stubGlobal("fetch", requests);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
function tree(enabled = true) {
    const assign = vi.fn().mockResolvedValue(undefined),
        move = vi.fn().mockResolvedValue(undefined),
        select = vi.fn();
    const result = render(
        <ConfirmDialogProvider>
            <PersonSharingProvider value={enabled}>
                <FolderTree
                    folders={folders}
                    assignments={[
                        { recordingId: "audio", folderId: "attached" },
                    ]}
                    recordings={[recording]}
                    selectedFolderId="attached"
                    onRecent={vi.fn()}
                    onSelectFolder={select}
                    onSettings={vi.fn()}
                    onMoveFolder={move}
                    onAssignRecording={assign}
                />
            </PersonSharingProvider>
        </ConfirmDialogProvider>,
    );
    return { ...result, assign, move, select };
}
describe("folder person sharing UI", () => {
    it("shows owner sharing next to creation and settings and uses the outgoing mark", async () => {
        tree();
        const row = screen.getByRole("button", {
            name: "Research, 0 recordings",
        });
        expect(
            row.querySelector(".lucide-folder-output.text-person-share"),
        ).toBeTruthy();
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Folder actions for Research" }),
            { button: 0, ctrlKey: false },
        );
        expect(screen.getByText("New subfolder")).toBeTruthy();
        expect(screen.getByText("Folder settings")).toBeTruthy();
        fireEvent.click(screen.getByText("Share folder…"));
        expect(
            await screen.findByRole("dialog", { name: "Share folder" }),
        ).toBeTruthy();
        expect(
            screen.getByText(/Only items directly in this folder/),
        ).toBeTruthy();
        expect(
            screen.getByText(
                /Sharing with people does not share them with the Organization/,
            ),
        ).toBeTruthy();
    });
    it("shows receiver names and states in folder settings", async () => {
        render(
            <ConfirmDialogProvider>
                <PersonSharingProvider value>
                    <FolderSettingsPanel
                        folder={outgoing}
                        folders={folders}
                        count={1}
                        open
                        onOpenChange={vi.fn()}
                        onRename={vi.fn()}
                        onCreate={vi.fn()}
                        onMove={vi.fn()}
                        onDelete={vi.fn()}
                        exportProviders={{
                            filesystem: false,
                            googleDrive: false,
                            mail: false,
                        }}
                    />
                </PersonSharingProvider>
            </ConfirmDialogProvider>,
        );
        expect(await screen.findByText("Lena Fischer")).toBeTruthy();
        expect(screen.getByText("Accepted")).toBeTruthy();
        expect(requests).toHaveBeenCalledWith("/api/folders/outgoing/shares");
    });
    it("opens no folder settings for a received attachment", () => {
        render(
            <ConfirmDialogProvider>
                <PersonSharingProvider value>
                    <FolderSettingsPanel
                        folder={attached}
                        folders={folders}
                        count={1}
                        open
                        onOpenChange={vi.fn()}
                        onRename={vi.fn()}
                        onCreate={vi.fn()}
                        onMove={vi.fn()}
                        onDelete={vi.fn()}
                        exportProviders={{
                            filesystem: false,
                            googleDrive: false,
                            mail: false,
                        }}
                    />
                </PersonSharingProvider>
            </ConfirmDialogProvider>,
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByText("Delete folder")).toBeNull();
        expect(requests).not.toHaveBeenCalled();
    });
    it("uses folder invitation routes for every owner state", async () => {
        requests.mockImplementation(async (_path: string, init?: RequestInit) =>
            Response.json(
                init?.method
                    ? { success: true }
                    : {
                          shares: [
                              "pending",
                              "accepted",
                              "declined",
                              "removed",
                          ].map((state, index) => ({
                              ...share,
                              id: `share-${index}`,
                              receiverUserId: `receiver-${index}`,
                              state,
                          })),
                      },
            ),
        );
        render(
            <PersonShareDialog
                itemId="outgoing"
                kind="folder"
                title="Research"
                open
                onOpenChange={vi.fn()}
            />,
        );
        expect(await screen.findByText("Waiting for acceptance")).toBeTruthy();
        for (const state of ["Accepted", "Declined", "Removed"])
            expect(screen.getByText(state)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/folder-shares/share-0",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({ action: "cancel", version: 1 }),
                }),
            ),
        );
    });
    it("accepts with an editable name and placement in the private tree", async () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations
                    initialInvitations={[invitation]}
                    folders={folders}
                />
            </PersonSharingProvider>,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Invitations (1)" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Accept and attach…" }),
        );
        expect(
            screen.getByRole("dialog", { name: "Attach shared folder" }),
        ).toBeTruthy();
        const name = screen.getByRole("textbox", { name: "Name in your tree" });
        expect((name as HTMLInputElement).value).toBe("Owner research");
        fireEvent.change(name, { target: { value: "My research" } });
        expect(
            screen.queryByRole("option", { name: "Organization" }),
        ).toBeNull();
        expect(
            screen.queryByRole("option", { name: "Local research" }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("option", { name: "Projects" }));
        fireEvent.click(screen.getByRole("button", { name: "Attach" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/folder-shares/invite",
                expect.objectContaining({
                    body: JSON.stringify({
                        action: "accept",
                        version: 0,
                        name: "My research",
                        parentId: "mine",
                    }),
                }),
            ),
        );
        expect(refresh).toHaveBeenCalled();
    });
    it("announces live folder invitations through the existing corner notice", async () => {
        render(
            <PersonSharingProvider value>
                <PersonInvitations initialInvitations={[]} folders={folders} />
            </PersonSharingProvider>,
        );
        requests.mockResolvedValueOnce(
            Response.json({ invitations: [invitation] }),
        );
        await act(async () =>
            vi.mocked(subscribeEvents).mock.calls[0][0]({ type: "share" }),
        );
        expect(
            screen.getByRole("button", { name: "Invitations (1)" }),
        ).toBeTruthy();
        render(notices.mock.calls[0][0]());
        expect(
            screen.getByText("Alex Morgan shared a folder with you"),
        ).toBeTruthy();
    });
    it("shows incoming count, tooltip and only receiver actions", () => {
        tree();
        const row = screen.getByRole("button", {
            name: "Local research, 1 recording",
        });
        expect(row.title).toBe(
            "Shared by Alex Morgan · read-only · originally Owner research",
        );
        expect(row.getAttribute("draggable")).toBe("false");
        expect(
            row.querySelector(".lucide-folder-input.text-person-share"),
        ).toBeTruthy();
        fireEvent.click(row);
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "Folder actions for Local research",
            }),
            { button: 0, ctrlKey: false },
        );
        for (const label of [
            "Rename for me",
            "Move",
            "Shared by Alex Morgan",
            "Remove and end sharing",
        ])
            expect(screen.getByText(label)).toBeTruthy();
        expect(screen.queryByText("Folder settings")).toBeNull();
        expect(screen.queryByText("New subfolder")).toBeNull();
        expect(canCreateSubfolder(attached, true, true)).toBe(false);
    });
    it.each([
        "rename",
        "move",
    ] as const)("edits only the receiver's attachment: %s", async (action) => {
        render(
            <ReceivedFolderDialog
                shareId="share"
                version={1}
                name={attached.name}
                ownerName="Alex Morgan"
                parentId="mine"
                action={action}
                folders={folders}
                open
                onOpenChange={vi.fn()}
            />,
        );
        if (action === "rename")
            fireEvent.change(
                screen.getByRole("textbox", { name: "Name in your tree" }),
                { target: { value: "Renamed locally" } },
            );
        else
            fireEvent.click(
                screen.getByRole("button", { name: "Private root" }),
            );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/folder-shares/share",
                expect.objectContaining({
                    body: JSON.stringify({
                        action,
                        version: 1,
                        name:
                            action === "rename"
                                ? "Renamed locally"
                                : attached.name,
                        parentId: action === "move" ? null : "mine",
                    }),
                }),
            ),
        );
    });
    it("confirms removal and ends the folder share", async () => {
        tree();
        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "Folder actions for Local research",
            }),
            { button: 0, ctrlKey: false },
        );
        fireEvent.click(screen.getByText("Remove and end sharing"));
        expect(await screen.findByRole("alertdialog")).toBeTruthy();
        expect(requests).not.toHaveBeenCalledWith(
            "/api/folder-shares/share",
            expect.anything(),
        );
        fireEvent.click(
            within(screen.getByRole("alertdialog")).getByRole("button", {
                name: "Remove and end sharing",
            }),
        );
        await waitFor(() =>
            expect(requests).toHaveBeenCalledWith(
                "/api/folder-shares/share",
                expect.objectContaining({
                    body: JSON.stringify({ action: "remove", version: 1 }),
                }),
            ),
        );
    });
    it("refuses item and folder drops onto an attachment", () => {
        const { assign, move } = tree();
        const row = screen.getByRole("button", {
            name: "Local research, 1 recording",
        });
        const transfer = {
            types: ["application/x-riffado-recording"],
            dropEffect: "copy",
            getData: () => "audio",
            setData: vi.fn(),
        };
        fireEvent.dragOver(row, { dataTransfer: transfer });
        expect(transfer.dropEffect).toBe("none");
        fireEvent.drop(row, { dataTransfer: transfer });
        const source = screen.getByRole("button", {
            name: "Projects, 0 recordings",
        });
        const folderTransfer = {
            ...transfer,
            types: ["application/x-riffado-folder"],
            getData: () => "mine",
        };
        fireEvent.dragStart(source, { dataTransfer: folderTransfer });
        const drop = createEvent.drop(row);
        Object.defineProperty(drop, "dataTransfer", { value: folderTransfer });
        fireEvent(row, drop);
        expect(assign).not.toHaveBeenCalled();
        expect(move).not.toHaveBeenCalled();
    });
    it("excludes attachments from filing pickers and upload targets while marking outgoing folders", () => {
        render(
            <FolderPicker
                folders={folders}
                assignedIds={new Set()}
                open
                onOpenChange={vi.fn()}
                onSelect={vi.fn()}
            />,
        );
        expect(
            screen.queryByRole("option", { name: "Local research" }),
        ).toBeNull();
        expect(
            screen
                .getByRole("option", { name: "Research" })
                .querySelector(".lucide-folder-output"),
        ).toBeTruthy();
        expect(
            uploadFolderOptions(folders, true, (folder) => folder.name).some(
                (folder) => folder.id === "attached",
            ),
        ).toBe(false);
    });
    it("finds attachments in the command palette under their own name", async () => {
        const select = vi.fn();
        render(
            <CommandPalette
                folders={folders}
                open
                onOpenChange={vi.fn()}
                onSelectFolder={select}
                currentTheme="system"
                dateTimeFormat="relative"
                onSync={vi.fn()}
                onUpload={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
                onSetTheme={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "local research" },
        });
        const row = screen.getByRole("option", { name: /Local research/ });
        expect(row.querySelector(".lucide-folder-input")).toBeTruthy();
        fireEvent.click(row);
        await waitFor(() => expect(select).toHaveBeenCalledWith(attached));
    });
    it("keeps attachments in recently used navigation and folder search", () => {
        function Navigation() {
            const preferences = useLibraryPreferencesState(
                undefined,
                folders,
                [{ recordingId: "audio", folderId: attached.id }],
                [recording],
            );
            return (
                <LibraryPreferencesContext.Provider value={preferences}>
                    <ConfirmDialogProvider>
                        <LibraryLocationHeader
                            variant="walk"
                            organization={{
                                folders,
                                assignments: [
                                    {
                                        recordingId: "audio",
                                        folderId: attached.id,
                                    },
                                ],
                            }}
                            recordings={[recording]}
                            folder={null}
                            onNavigate={vi.fn()}
                            onSettings={vi.fn()}
                            onNewFolder={vi.fn()}
                            onAssign={vi.fn()}
                            onMove={vi.fn()}
                        />
                    </ConfirmDialogProvider>
                </LibraryPreferencesContext.Provider>
            );
        }
        render(<Navigation />);
        expect(
            screen.getByRole("group", { name: "Recently used" }).textContent,
        ).toContain("Local research");
        cleanup();
        tree();
        fireEvent.change(
            screen.getByRole("textbox", { name: "Search folders" }),
            { target: { value: "local research" } },
        );
        expect(
            screen.getByRole("button", { name: "Local research, 1 recording" }),
        ).toBeTruthy();
    });
    it.each([
        {
            response: () => Response.json({}, { status: 500 }),
            label: "missing",
        },
        {
            response: () => new Response("invalid", { status: 500 }),
            label: "invalid",
        },
        {
            response: () => Response.json({ error: "" }, { status: 500 }),
            label: "empty",
        },
    ])("uses a localized fallback for $label folder errors", async ({
        response,
    }) => {
        requests.mockResolvedValueOnce(response());
        await expect(
            changeFolderShareRequest(
                "share",
                1,
                "remove",
                "Sdílení se nepodařilo změnit",
            ),
        ).rejects.toThrow("Sdílení se nepodařilo změnit");
    });
    it.each([
        true,
        false,
    ])("shows the owner's outgoing item marker only when sharedWithPeople=%s", (sharedWithPeople) => {
        render(
            <ConfirmDialogProvider>
                <PersonSharingProvider value>
                    <RecordingRow
                        recording={{
                            ...recording,
                            view: "private",
                            isOwn: true,
                            sharedWithPeople,
                        }}
                        isSelected={false}
                        inFlight={undefined}
                        snippet={null}
                        isCompact={false}
                        rowPadding="p-2"
                        dateTimeFormat="relative"
                        onSelect={vi.fn()}
                        onDelete={vi.fn()}
                        registerRef={vi.fn()}
                    />
                </PersonSharingProvider>
            </ConfirmDialogProvider>,
        );
        expect(Boolean(screen.queryByLabelText("Shared with people"))).toBe(
            sharedWithPeople,
        );
    });
    it("offers no person sharing action when disabled", () => {
        tree(false);
        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Folder actions for Research" }),
            { button: 0, ctrlKey: false },
        );
        expect(screen.queryByText("Share folder…")).toBeNull();
    });
});
