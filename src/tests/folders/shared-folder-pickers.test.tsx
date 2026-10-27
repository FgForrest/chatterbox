// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    UploadDialog,
    uploadFolderOptions,
    uploadFolderParents,
} from "@/components/dashboard/upload-dialog";
import { AttachRecordingDialog } from "@/components/meetings/attach-recording-dialog";
import { CreateMeetingDialog } from "@/components/meetings/create-meeting-dialog";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { FolderPicker } from "@/components/recordings/folder-picker";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { TaskFolderPicker } from "@/components/tasks/task-folder-picker";
import { matchFolders } from "@/lib/folders/navigation";
import { detail } from "@/tests/meetings/ui-fixtures";
import type { RecordingFolder } from "@/types/folder";

const root: RecordingFolder = {
    id: "root",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const shared: RecordingFolder = {
    ...root,
    id: "attachment",
    name: "My Acme",
    parentId: "root",
    kind: "custom",
    receivedFolder: {
        sourceFolderId: "source",
        shareId: "share",
        shareVersion: 1,
        ownerName: "Jitka Dvořáková",
        originalName: "Acme",
    },
};
const folders = [root, shared];
const fetchMock = vi.fn();
beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    fetchMock.mockReset().mockResolvedValue(
        Response.json({
            reason: "not_configured",
            recurring: [],
            other: [],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("participant filing pickers", () => {
    it.each([
        "dialog",
        "inline",
    ])("offers the attachment name and person-share icon in the %s picker", async (variant) => {
        const select = vi.fn().mockResolvedValue(undefined);
        if (variant === "dialog")
            render(
                <FolderPicker
                    folders={folders}
                    assignedIds={new Set()}
                    open
                    onOpenChange={vi.fn()}
                    onSelect={select}
                />,
            );
        else {
            render(
                <FolderCombobox
                    entries={matchFolders(folders, "").filter(
                        (entry) => entry.folder.kind === "custom",
                    )}
                    value="attachment"
                    onValueChange={select}
                />,
            );
            fireEvent.click(screen.getByRole("combobox"));
        }
        const option = screen.getByRole("option", { name: /My Acme/ });
        expect(option.querySelector("svg.text-person-share")).toBeTruthy();
        fireEvent.click(option);
        await waitFor(() => expect(select).toHaveBeenCalledWith("attachment"));
    });
    it("keeps received-item private filing restricted to owned folders", () => {
        render(
            <FolderPicker
                folders={folders}
                scope="personal"
                assignedIds={new Set()}
                open
                onOpenChange={vi.fn()}
                onSelect={vi.fn()}
            />,
        );
        expect(screen.queryByRole("option", { name: /My Acme/ })).toBeNull();
    });
    it("offers shared upload targets and excludes them from new-folder parents", () => {
        const options = uploadFolderOptions(
            folders,
            false,
            (folder) => folder.name,
        );
        expect(options).toMatchObject([
            { id: "attachment", name: "My Acme", path: "Private / My Acme" },
        ]);
        expect(
            uploadFolderParents(folders, false, (folder) => folder.name).map(
                (folder) => folder.id,
            ),
        ).toEqual(["root"]);
        const upload = vi.fn();
        render(
            <UploadDialog
                file={null}
                folders={options}
                folderParents={[]}
                open
                onOpenChange={vi.fn()}
                onUpload={upload}
                selectedFolderId="attachment"
            />,
        );
        expect(screen.getByRole("combobox").textContent).toContain("My Acme");
        expect(
            screen.getByRole("combobox").querySelector("svg.text-person-share"),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));
        expect(upload).toHaveBeenCalledWith("attachment");
    });
    it("prepares a meeting in the selected shared attachment", async () => {
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
            init.method === "POST"
                ? Response.json({ id: "agenda" })
                : Response.json({
                      reason: "not_configured",
                      recurring: [],
                      other: [],
                  }),
        );
        const created = vi.fn();
        render(
            <CreateMeetingDialog
                folders={folders}
                folderId="attachment"
                open
                onOpenChange={vi.fn()}
                onCreated={created}
            />,
        );
        expect(
            screen
                .getByRole("combobox", { name: "Folder" })
                .querySelector("svg.text-person-share"),
        ).toBeTruthy();
        fireEvent.change(
            await screen.findByRole("textbox", { name: "Title" }),
            { target: { value: "Acme agenda" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
        await waitFor(() =>
            expect(created).toHaveBeenCalledWith("agenda", undefined),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings",
            expect.objectContaining({
                body: JSON.stringify({
                    folderId: "attachment",
                    title: "Acme agenda",
                }),
            }),
        );
    });
    it.each([
        "audio",
        "mail",
    ] as const)("lets a folder owner unfile a contributed %s without offering item writes", async (kind) => {
        const remove = vi.fn().mockResolvedValue(undefined);
        render(
            <RecordingFolderTags
                recordingId="contribution"
                kind={kind}
                folders={[
                    {
                        ...root,
                        id: "source",
                        name: "Acme",
                        parentId: root.id,
                        kind: "custom",
                        sharedWithPeople: true,
                    },
                ]}
                assignments={[
                    { recordingId: "contribution", folderId: "source" },
                ]}
                isOwn={false}
                canUnfilePersonal
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={remove}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Acme" }),
        );
        await waitFor(() =>
            expect(remove).toHaveBeenCalledWith("contribution", "source"),
        );
        expect(
            screen.queryByRole("button", { name: "Add to folder" }),
        ).toBeNull();
    });
    it("keeps own-task filing limited to the caller's actual private folders", () => {
        render(
            <TaskFolderPicker
                folders={folders}
                value={null}
                onChange={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Task folder" }));
        expect(screen.queryByRole("option", { name: /My Acme/ })).toBeNull();
        expect(screen.getByRole("option", { name: "No folder" })).toBeTruthy();
    });
    it("hands agenda uploads to the receiver's selectable folder attachment", () => {
        const uploaded = vi.fn();
        window.addEventListener("meeting-upload", uploaded);
        try {
            render(
                <AttachRecordingDialog
                    detail={detail({
                        state: "held",
                        folders: [
                            {
                                id: "source",
                                name: "Acme",
                                userId: "owner",
                                parentId: "owner-root",
                            },
                        ],
                    })}
                    folders={folders}
                    recordings={[]}
                    open
                    onOpenChange={vi.fn()}
                    onAttached={vi.fn()}
                />,
            );
            fireEvent.click(
                screen.getByRole("button", { name: "Upload a file…" }),
            );
            expect(uploaded).toHaveBeenCalledWith(
                expect.objectContaining({
                    detail: { agendaId: "agenda", folderId: "attachment" },
                }),
            );
        } finally {
            window.removeEventListener("meeting-upload", uploaded);
        }
    });
});
