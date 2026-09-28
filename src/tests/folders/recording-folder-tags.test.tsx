// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import type { RecordingFolder } from "@/types/folder";

const folder: RecordingFolder = {
    id: "meetings",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};

describe("recording folder tags", () => {
    afterEach(cleanup);

    it("opens the assigned folder and removes only that assignment", async () => {
        const onSelectFolder = vi.fn();
        const onRemove = vi.fn().mockResolvedValue(undefined);
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder]}
                assignments={[{ recordingId: "rec-1", folderId: "meetings" }]}
                onSelectFolder={onSelectFolder}
                onAdd={vi.fn()}
                onRemove={onRemove}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
        expect(onSelectFolder).toHaveBeenCalledWith(folder);

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Meetings" }),
        );
        expect(onRemove).toHaveBeenCalledWith("rec-1", "meetings");
    });

    it("does not offer the implicit Private root as an assignment", () => {
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[
                    {
                        id: "private",
                        parentId: null,
                        name: "Private",
                        kind: "private",
                        sortOrder: 0,
                        scope: "personal",
                        version: 0,
                    },
                ]}
                assignments={[]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Private" })).toBeNull();
    });

    const orgRoot: RecordingFolder = {
        id: "org-root",
        parentId: null,
        name: "Organization",
        kind: "public",
        sortOrder: 1000,
        scope: "org",
        version: 0,
    };
    const sales: RecordingFolder = {
        id: "sales",
        parentId: "org-root",
        name: "Sales",
        kind: "custom",
        sortOrder: 0,
        scope: "org",
        version: 0,
    };

    it("lets another member refile but not withdraw a shared recording", () => {
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[{ recordingId: "rec-1", folderId: "org-root" }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
                onMove={vi.fn()}
                isOwn={false}
                organizationOnly
            />,
        );

        expect(
            screen.getByRole("button", { name: "Organization" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Remove from Organization" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: /Add to folder/ }),
        ).toBeNull();
        expect(screen.getByRole("button", { name: /Move to/ })).toBeTruthy();
        // Private folders of the owner are not the member's to see.
        expect(screen.queryByRole("button", { name: "Meetings" })).toBeNull();
    });

    it("lets the owner withdraw a shared recording, once confirmed with what their retention will delete", async () => {
        const onRemove = vi.fn().mockResolvedValue(undefined);
        const fetchMock = vi.fn(async () =>
            Response.json({ due: [{ kind: "audio", days: 30 }] }),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[{ recordingId: "rec-1", folderId: "sales" }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={onRemove}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Sales" }),
        );
        // Its last Organization folder: leaving it withdraws the recording.
        expect(onRemove).not.toHaveBeenCalled();
        expect((await screen.findByRole("alert")).textContent).toContain(
            "audio older than 30 days",
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/rec-1/withdraw-preview",
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Take out of the Organization",
            }),
        );
        expect(onRemove).toHaveBeenCalledWith("rec-1", "sales", true);
        vi.unstubAllGlobals();
    });

    it("confirms nothing before the retention check has answered", () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise<Response>(() => {})),
        );
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[{ recordingId: "rec-1", folderId: "sales" }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Sales" }),
        );
        expect(
            (
                screen.getByRole("button", {
                    name: "Take out of the Organization",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        vi.unstubAllGlobals();
    });

    it("asks for the confirmation when the server finds it was the last Organization folder", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ due: [] })),
        );
        const onRemove = vi
            .fn()
            .mockRejectedValueOnce(
                Object.assign(new Error("last one"), {
                    code: "WITHDRAW_UNCONFIRMED",
                }),
            )
            .mockResolvedValue(undefined);
        // Another tab removed the root; this one still shows both.
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[
                    { recordingId: "rec-1", folderId: "sales" },
                    { recordingId: "rec-1", folderId: "org-root" },
                ]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={onRemove}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Sales" }),
        );
        expect(onRemove).toHaveBeenCalledWith("rec-1", "sales");
        const confirm = (await screen.findByRole("button", {
            name: "Take out of the Organization",
        })) as HTMLButtonElement;
        await vi.waitFor(() => expect(confirm.disabled).toBe(false));
        fireEvent.click(confirm);
        expect(onRemove).toHaveBeenLastCalledWith("rec-1", "sales", true);
        vi.unstubAllGlobals();
    });
});
