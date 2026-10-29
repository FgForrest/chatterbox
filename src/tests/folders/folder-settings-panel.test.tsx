// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderSettingsPanel } from "@/components/dashboard/folder-settings-panel";
import type { RecordingFolder } from "@/types/folder";

vi.mock("@/components/dashboard/folder-export-actions", () => ({
    FolderExportActions: ({
        privateTree,
        hideTrigger,
    }: {
        privateTree: boolean;
        hideTrigger?: boolean;
    }) =>
        hideTrigger ? null : (
            <button type="button" data-editable={privateTree}>
                Export
            </button>
        ),
}));
vi.mock("@/components/dashboard/folder-default-profiles", () => ({
    FolderDefaultProfiles: ({ readOnly }: { readOnly: boolean }) => (
        <button type="button" disabled={readOnly}>
            Processing
        </button>
    ),
}));
const root: RecordingFolder = {
    id: "private",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "meetings",
    parentId: root.id,
    name: "Meetings",
    kind: "custom",
};
const other: RecordingFolder = { ...folder, id: "other", name: "Archive" };
const nested: RecordingFolder = {
    ...folder,
    id: "nested",
    parentId: folder.id,
    name: "Nested",
};
const rename = vi.fn().mockResolvedValue(undefined);
const remove = vi.fn().mockResolvedValue(undefined);
const close = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () =>
            Response.json({
                writable: true,
                addresses: [
                    {
                        id: "address",
                        kind: "folder",
                        address: "invented@example.com",
                        primary: true,
                        folderId: folder.id,
                        label: null,
                        baseAddressId: null,
                        lastReceivedAt: null,
                        createdAt: "2026-10-21T10:00:00Z",
                    },
                ],
            }),
        ),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function panel(organization = false, canCurate = false, isRoot = false) {
    const target = organization ? { ...folder, scope: "org" as const } : folder;
    if (isRoot) target.parentId = null;
    render(
        <ConfirmDialogProvider>
            <FolderSettingsPanel
                folder={target}
                folders={[root, target, other, nested]}
                count={3}
                open
                onOpenChange={close}
                onRename={rename}
                onDelete={remove}
                exportProviders={{
                    filesystem: false,
                    googleDrive: false,
                    mail: false,
                }}
                mailEnabled
                canCurate={canCurate}
            />
        </ConfirmDialogProvider>,
    );
}

describe("folder settings panel", () => {
    it("retains count, path, addresses, processing defaults and export", async () => {
        panel();
        expect(screen.getByText("Private › Meetings · 3 items")).toBeTruthy();
        expect(await screen.findByText("invented@example.com")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Processing" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Configure" })).toBeTruthy();
    });
    it("opens with the name as text without autofocus or preselected text", () => {
        panel();
        expect(
            screen.queryByRole("textbox", { name: "Folder name" }),
        ).toBeNull();
        expect(document.activeElement?.tagName).not.toBe("INPUT");
        expect(window.getSelection()?.toString()).toBe("");
    });
    it("renames and keeps create and move out of settings", async () => {
        panel();
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
            target: { value: "Renamed" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(rename).toHaveBeenCalledWith("meetings", "Renamed"),
        );
        expect(
            screen.queryByRole("button", { name: "New subfolder" }),
        ).toBeNull();
        expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
    });
    it("confirms deletion with affected mail addresses", async () => {
        panel();
        fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
        expect(
            await screen.findByText(
                "These mail addresses stop working for good, and nobody can be given them again:",
            ),
        ).toBeTruthy();
        expect(
            screen.getAllByText("invented@example.com").length,
        ).toBeGreaterThan(0);
        expect(remove).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
        await waitFor(() => expect(remove).toHaveBeenCalledWith("meetings"));
        expect(close).toHaveBeenCalledWith(false);
    });
    it("lets members inspect Organization settings while preventing curation and address edits", async () => {
        panel(true);
        expect(await screen.findByText("invented@example.com")).toBeTruthy();
        expect(
            screen.queryByRole("textbox", { name: "Folder name" }),
        ).toBeNull();
        expect(
            screen.getByRole("button", { name: "Processing" }),
        ).toHaveProperty("disabled", true);
        expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "New subfolder" }),
        ).toBeNull();
        expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Delete folder" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: "Change the folder's address",
            }),
        ).toBeNull();
    });
    it("does not let members create below the Organization root", () => {
        panel(true, false, true);
        expect(
            screen.queryByRole("button", { name: "New subfolder" }),
        ).toBeNull();
    });
    it.each([
        { addresses: [] },
        { addresses: [{ primary: false, address: "old@example.com" }] },
    ])("hides the whole mail row without a primary address: $addresses", async ({
        addresses,
    }) => {
        const fetchMock = vi.fn(async () =>
            Response.json({ writable: false, addresses }),
        );
        vi.stubGlobal("fetch", fetchMock);
        panel();
        await waitFor(() => expect(fetchMock).toHaveResolved());
        expect(
            screen.queryByRole("heading", { name: "Mail to folder" }),
        ).toBeNull();
        expect(screen.queryByText("old@example.com")).toBeNull();
    });
    it("lets curators edit Organization settings", () => {
        panel(true, true);
        expect(
            screen.getByRole("button", { name: "Processing" }),
        ).toHaveProperty("disabled", false);
        expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Delete folder" }),
        ).toBeTruthy();
    });
});
