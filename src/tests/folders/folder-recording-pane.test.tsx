// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderRecordingPane } from "@/components/dashboard/folder-recording-pane";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const privateRoot: RecordingFolder = {
    id: "private",
    parentId: null,
    name: "Private",
    kind: "private",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};
const meetings: RecordingFolder = {
    id: "meetings",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};
const planning: RecordingFolder = {
    id: "planning",
    parentId: "meetings",
    name: "Planning",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};
const orgRoot: RecordingFolder = {
    id: "org-root",
    parentId: null,
    name: "Organization",
    kind: "public",
    sortOrder: 0,
    scope: "org",
    version: 0,
};
const orgPlanning: RecordingFolder = {
    ...planning,
    id: "org-planning",
    parentId: orgRoot.id,
    name: "Organization planning",
    scope: "org",
};
const recordings: Recording[] = [
    {
        id: "rec-direct",
        filename: "Direct meeting",
        duration: 60_000,
        filesize: 1000,
        startTime: new Date(0).toISOString(),
        deviceSn: "local",
    },
    {
        id: "rec-child",
        filename: "Child meeting",
        duration: 120_000,
        filesize: 2000,
        startTime: new Date(1).toISOString(),
        deviceSn: "local",
    },
];

function renderPane(folder: RecordingFolder, canCurate = false) {
    render(
        <ConfirmDialogProvider>
            <FolderRecordingPane
                folder={folder}
                folders={[
                    privateRoot,
                    meetings,
                    planning,
                    orgRoot,
                    orgPlanning,
                ]}
                assignments={[
                    { recordingId: "rec-direct", folderId: "meetings" },
                    { recordingId: "rec-child", folderId: "planning" },
                ]}
                recordings={recordings}
                dateTimeFormat="relative"
                onSelectRecording={vi.fn()}
                onRenameFolder={vi.fn()}
                onDeleteFolder={vi.fn()}
                hiddenOnMobile={false}
                onBackToFolders={vi.fn()}
                exportProviders={{
                    filesystem: false,
                    googleDrive: false,
                    mail: false,
                }}
                canCurate={canCurate}
            />
        </ConfirmDialogProvider>,
    );
}

describe("folder recording pane", () => {
    afterEach(cleanup);

    it("includes recordings assigned to descendant folders", () => {
        renderPane(meetings);
        expect(screen.getByText("Direct meeting")).toBeTruthy();
        expect(screen.getByText("Child meeting")).toBeTruthy();
        expect(screen.getByText("2 recordings")).toBeTruthy();
    });

    it("lists every recording in the Private root", () => {
        renderPane(privateRoot);
        expect(screen.getByText("Direct meeting")).toBeTruthy();
        expect(screen.getByText("Child meeting")).toBeTruthy();
        expect(screen.getByText("2 recordings")).toBeTruthy();
        expect(screen.getByText("Meetings")).toBeTruthy();
        expect(screen.getByText("Planning")).toBeTruthy();
    });

    it("makes recording titles draggable as folder assignments", () => {
        renderPane(privateRoot);
        const dataTransfer = {
            effectAllowed: "none",
            setData: vi.fn(),
        };

        fireEvent.dragStart(
            screen.getByRole("button", { name: "Open Direct meeting" }),
            { dataTransfer },
        );

        expect(dataTransfer.setData).toHaveBeenCalledWith(
            "application/x-riffado-recording",
            "rec-direct",
        );
        expect(dataTransfer.effectAllowed).toBe("copy");
    });

    it("always renders export settings and hides synchronization without an applicable export", () => {
        renderPane(meetings);
        expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Default profiles" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Synchronize" }),
        ).toBeNull();
    });

    it("hides Organization rename and delete controls from members", () => {
        renderPane(orgPlanning);

        expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("shows Organization rename and delete controls to curators", () => {
        renderPane(orgPlanning, true);

        expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    it("sorts the recording table by every displayed column", () => {
        renderPane(privateRoot);

        expect(
            screen.getByRole("button", { name: "Sort by Title" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Sort by Date, descending",
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Sort by Duration" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Sort by Size" }),
        ).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Sort by Title" }));
        fireEvent.click(
            screen.getByRole("button", {
                name: "Sort by Title, ascending",
            }),
        );
        const rows = screen.getAllByRole("button", { name: /^Open / });
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Open Direct meeting",
            "Open Child meeting",
        ]);
    });
});
