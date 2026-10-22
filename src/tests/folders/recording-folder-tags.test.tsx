// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    beforeEach(() => {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
                unobserve() {}
            },
        );
        Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

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

    it("lets a curator refile but not withdraw a shared recording", () => {
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
                canCurate
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

    it.each([
        {
            role: "owner",
            isOwn: true,
            canCurate: false,
            canWithdraw: true,
        },
        {
            role: "curator",
            isOwn: false,
            canCurate: true,
            canWithdraw: false,
        },
        {
            role: "organization account",
            isOwn: false,
            canCurate: false,
            canWithdraw: true,
        },
        {
            role: "member",
            isOwn: false,
            canCurate: false,
            canWithdraw: false,
        },
    ])("allows the Organization picker for $role and moves non-owned items", async ({
        isOwn,
        canCurate,
        canWithdraw,
    }) => {
        const onAdd = vi.fn().mockResolvedValue(undefined);
        const onMove = vi.fn().mockResolvedValue(undefined);
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[{ recordingId: "rec-1", folderId: orgRoot.id }]}
                onSelectFolder={vi.fn()}
                onAdd={onAdd}
                onRemove={vi.fn()}
                onMove={onMove}
                isOwn={isOwn}
                canCurate={canCurate}
                canWithdraw={canWithdraw}
                organizationOnly
            />,
        );
        const action = screen.getByRole("button", {
            name: isOwn ? "Add to folder" : "Move to…",
        });
        if (!canWithdraw)
            expect(
                screen.queryByRole("button", {
                    name: "Remove from Organization",
                }),
            ).toBeNull();
        fireEvent.click(action);
        expect(screen.queryByRole("option", { name: "Meetings" })).toBeNull();
        expect(screen.queryByText("Private")).toBeNull();
        fireEvent.click(screen.getByRole("option", { name: "Sales" }));
        await vi.waitFor(() =>
            isOwn
                ? expect(onAdd).toHaveBeenCalledWith("rec-1", sales.id)
                : expect(onMove).toHaveBeenCalledWith(
                      "rec-1",
                      orgRoot.id,
                      sales.id,
                  ),
        );
        if (!isOwn) expect(onAdd).not.toHaveBeenCalled();
    });

    it("hides Move when every Organization destination is already assigned", () => {
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, sales]}
                assignments={[{ recordingId: "rec-1", folderId: sales.id }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
                onMove={vi.fn()}
                isOwn={false}
                canCurate
                organizationOnly
            />,
        );
        expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
    });

    it("labels Organization destinations as sharing for a private item", () => {
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder, orgRoot, sales]}
                assignments={[]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Add to folder" }));
        expect(screen.getByText("Share with the Organization")).toBeTruthy();
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

    it("uses mail withdrawal copy and omits audio and transcript retention", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    due: [
                        { kind: "audio", days: 30 },
                        { kind: "transcript", days: 14 },
                        { kind: "summary", days: 7 },
                    ],
                }),
            ),
        );
        render(
            <RecordingFolderTags
                recordingId="mail-1"
                kind="mail"
                folders={[folder, orgRoot, sales]}
                assignments={[{ recordingId: "mail-1", folderId: "sales" }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Sales" }),
        );

        expect(
            await screen.findByRole("heading", {
                name: "Take this mail out of the Organization?",
            }),
        ).toBeTruthy();
        const warning = await screen.findByRole("alert");
        expect(warning.textContent).toContain("this mail's summary");
        expect(warning.textContent).not.toContain("audio");
        expect(warning.textContent).not.toContain("transcript");
        expect(warning.textContent).not.toContain("recording");
        vi.unstubAllGlobals();
    });

    it("lets the organization account withdraw a shared recording, once it confirmed what the owner's retention will delete", async () => {
        const onRemove = vi.fn().mockResolvedValue(undefined);
        const fetchMock = vi.fn(async () =>
            Response.json({ due: [{ kind: "audio", days: 30 }] }),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[orgRoot, sales]}
                assignments={[{ recordingId: "rec-1", folderId: "sales" }]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={onRemove}
                onMove={vi.fn()}
                isOwn={false}
                canWithdraw
                organizationOnly
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Sales" }),
        );
        expect(onRemove).not.toHaveBeenCalled();
        expect((await screen.findByRole("alert")).textContent).toContain(
            "The owner's retention deletes audio older than 30 days",
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/rec-1/withdraw-preview?view=org",
        );
        expect(screen.getByText(/Its owner gets it back/)).toBeTruthy();
        // Sharing stays the owner's.
        expect(
            screen.queryByRole("button", { name: /Add to folder/ }),
        ).toBeNull();

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
