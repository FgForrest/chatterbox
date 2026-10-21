// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderSettingsPanel } from "@/components/dashboard/folder-settings-panel";
import type { RecordingFolder } from "@/types/folder";

const picker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/google/picker-client", () => ({
    pickDriveFolder: picker,
}));
vi.mock("@/components/dashboard/folder-default-profiles", () => ({
    FolderDefaultProfiles: () => <div>Default processing profile</div>,
}));
const folder: RecordingFolder = {
    id: "folder",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/dashboard");
});

describe("folder settings export", () => {
    it.each([
        "form",
        "list",
    ] as const)("opens the returned Google export %s after its URL parameter was consumed", async (reopenExport) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) =>
                String(input) === "/api/integrations/google"
                    ? Response.json({
                          available: true,
                          connection: {
                              email: "zorven@example.com",
                              status: "active",
                          },
                      })
                    : Response.json({ configured: [], applicableIds: [] }),
            ),
        );
        const handled = vi.fn();
        function ReturnedPanel() {
            const [pending, setPending] = useState<
                typeof reopenExport | undefined
            >(reopenExport);
            const [open, setOpen] = useState(true);
            return (
                <ConfirmDialogProvider>
                    <button type="button" onClick={() => setOpen(true)}>
                        Open settings
                    </button>
                    {open && (
                        <FolderSettingsPanel
                            folder={folder}
                            folders={[folder]}
                            count={1}
                            open
                            onOpenChange={setOpen}
                            onRename={vi.fn()}
                            onCreate={vi.fn()}
                            onMove={vi.fn()}
                            onDelete={vi.fn()}
                            exportProviders={{
                                filesystem: false,
                                googleDrive: true,
                                mail: false,
                            }}
                            reopenExport={pending}
                            onReopenHandled={() => {
                                handled();
                                setPending(undefined);
                            }}
                        />
                    )}
                </ConfirmDialogProvider>
            );
        }
        render(<ReturnedPanel />);
        expect(
            await screen.findByRole("heading", {
                name: "Folder export settings",
            }),
        ).toBeTruthy();
        if (reopenExport === "form")
            expect(await screen.findByText("Google Drive folder")).toBeTruthy();
        else
            expect(
                await screen.findByRole("button", {
                    name: "Add Google Drive export",
                }),
            ).toBeTruthy();
        expect(handled).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.getByRole("heading", { name: "Meetings" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
        expect(screen.getByRole("heading", { name: "Meetings" })).toBeTruthy();
        expect(
            screen.queryByRole("heading", { name: "Folder export settings" }),
        ).toBeNull();
        expect(handled).toHaveBeenCalledOnce();
    });
    it("shows the configured export target in its labelled row", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    configured: [
                        {
                            id: "export",
                            folderId: folder.id,
                            provider: "filesystem",
                            targetPath: "invented/exports",
                            exportAudio: true,
                            exportTranscript: true,
                            exportSummary: true,
                            exportMail: false,
                            googleDrive: null,
                            lastError: null,
                            lastErrorAt: null,
                        },
                    ],
                    applicableIds: ["export"],
                }),
            ),
        );
        render(
            <ConfirmDialogProvider>
                <FolderSettingsPanel
                    folder={folder}
                    folders={[folder]}
                    count={1}
                    open
                    onOpenChange={vi.fn()}
                    onRename={vi.fn()}
                    onCreate={vi.fn()}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    exportProviders={{
                        filesystem: true,
                        googleDrive: false,
                        mail: false,
                    }}
                />
            </ConfirmDialogProvider>,
        );
        expect(await screen.findByText("invented/exports")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    });
    it.each([
        false,
        true,
    ])("shows Organization export ownership rather than an unknown status: curator=%s", async (canCurate) => {
        const fetchMock = vi.fn(async () =>
            Response.json({ configured: [], applicableIds: [] }),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <ConfirmDialogProvider>
                <FolderSettingsPanel
                    folder={{ ...folder, scope: "org" }}
                    folders={[folder]}
                    count={1}
                    open
                    onOpenChange={vi.fn()}
                    onRename={vi.fn()}
                    onCreate={vi.fn()}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    exportProviders={{
                        filesystem: true,
                        googleDrive: true,
                        mail: false,
                    }}
                    canCurate={canCurate}
                />
            </ConfirmDialogProvider>,
        );
        expect(
            screen.getByText("Managed by the Organization account"),
        ).toBeTruthy();
        expect(screen.queryByText("Not configured")).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("shows the actual export target to the Organization account", async () => {
        const fetchMock = vi.fn(async () =>
            Response.json({
                configured: [
                    {
                        id: "export",
                        targetPath: "organization/exports",
                        googleDrive: null,
                    },
                ],
                applicableIds: ["export"],
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        render(
            <ConfirmDialogProvider>
                <FolderSettingsPanel
                    folder={{ ...folder, scope: "org" }}
                    folders={[folder]}
                    count={1}
                    open
                    onOpenChange={vi.fn()}
                    onRename={vi.fn()}
                    onCreate={vi.fn()}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    exportProviders={{
                        filesystem: true,
                        googleDrive: false,
                        mail: false,
                    }}
                    isOrgAccount
                    canCurate
                />
            </ConfirmDialogProvider>,
        );
        expect(await screen.findByText("organization/exports")).toBeTruthy();
        expect(
            screen.queryByText("Managed by the Organization account"),
        ).toBeNull();
        expect(fetchMock).toHaveBeenCalledWith("/api/folders/folder/exports");
    });
    it("releases both dialogs for Google's picker and restores folder settings afterward", async () => {
        window.history.replaceState(null, "", "/dashboard");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/folders/folder/exports")
                    return Response.json({ configured: [], applicableIds: [] });
                if (String(input) === "/api/integrations/google")
                    return Response.json({
                        available: true,
                        connection: {
                            email: "zorven@example.com",
                            status: "active",
                        },
                    });
                if (String(input) === "/api/integrations/google/picker-token")
                    return Response.json({
                        accessToken: "access",
                        apiKey: "key",
                        appId: "123",
                        clientId: "client",
                    });
                return Response.json({});
            }),
        );
        let finish: ((value: { id: string; name: string }) => void) | undefined;
        picker.mockImplementation(
            () =>
                new Promise<{ id: string; name: string }>((resolve) => {
                    finish = resolve;
                }),
        );
        render(
            <ConfirmDialogProvider>
                <FolderSettingsPanel
                    folder={folder}
                    folders={[folder]}
                    count={1}
                    open
                    onOpenChange={vi.fn()}
                    onRename={vi.fn()}
                    onCreate={vi.fn()}
                    onMove={vi.fn()}
                    onDelete={vi.fn()}
                    exportProviders={{
                        filesystem: false,
                        googleDrive: true,
                        mail: false,
                    }}
                />
            </ConfirmDialogProvider>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Configure" }));
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Add Google Drive export",
            }),
        );
        await screen.findByText("Connected as zorven@example.com");
        fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
        await waitFor(() => expect(picker).toHaveBeenCalled());
        expect(screen.queryByRole("dialog")).toBeNull();
        await act(async () =>
            finish?.({ id: "drive", name: "Invented exports" }),
        );
        expect(await screen.findByText("Invented exports")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.getByRole("heading", { name: "Meetings" })).toBeTruthy();
    });
});
